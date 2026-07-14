param(
  [Parameter(Mandatory = $true)]
  [string]$Phase,

  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider = "deepseek",

  [string]$Model = "deepseek-v4-pro",

  [string[]]$CaseId = @(),

  [string]$Commit = "HEAD",

  [string]$ResultsRoot = "",

  [switch]$InfrastructureProbe
)

# Gate Zero Layer 1. The evaluator harness is copied from a clean committed
# script set into an immutable per-run snapshot whose content hash is guarded.
# The source commit and source bytes are also checked again after execution. The
# engine, cases, dependencies, build output, and execution all live in a
# disposable detached worktree pinned to one commit resolved before any work.

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot "canary-support.ps1")
. (Join-Path $PSScriptRoot "credential.ps1")

$PinnedCommit = Resolve-CanaryCommit -RepositoryRoot $Root -Commit $Commit
$SafePhase = ($Phase -replace "[^a-zA-Z0-9_-]", "-").ToLowerInvariant().Trim("-")
if ([string]::IsNullOrWhiteSpace($SafePhase)) { $SafePhase = "unnamed" }
$RunId = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$([guid]::NewGuid().ToString('N'))"
$CanonicalResultsRoot = Join-Path $Root "gauntlet\results"
$ResolvedResultsRoot = if ([string]::IsNullOrWhiteSpace($ResultsRoot)) {
  $CanonicalResultsRoot
}
elseif ([IO.Path]::IsPathRooted($ResultsRoot)) {
  [IO.Path]::GetFullPath($ResultsRoot)
}
else {
  [IO.Path]::GetFullPath((Join-Path $Root $ResultsRoot))
}
New-Item -ItemType Directory -Force -Path $CanonicalResultsRoot | Out-Null

$LockPath = Join-Path $CanonicalResultsRoot ".canary.lock"
try {
  $Lock = Enter-CanaryLock -LockPath $LockPath
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 4
}

$RunDirectory = Join-Path $ResolvedResultsRoot "canary-runs\$SafePhase-$RunId"
$AggregateFile = Join-Path $RunDirectory "aggregate.json"
$CanaryFile = Join-Path $ResolvedResultsRoot "visible-diagnostic-canary-$SafePhase-$RunId.json"
$WorktreeBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$Worktree = Join-Path $WorktreeBase "vanguard-canary-$RunId"
$HarnessPaths = @(
  "run-canary.ps1",
  "run-private-gauntlet.ps1",
  "gauntlet-evaluator.mjs",
  "canary-support.ps1",
  "credential.ps1"
)
$HarnessSnapshot = Join-Path $RunDirectory "evaluator-harness"
$HarnessStart = $null
$HarnessEnd = $null
$HarnessSourceStart = $null
$HarnessSourceEnd = $null
$HarnessGitStart = $null
$HarnessGitEnd = $null
$ArtifactStart = $null
$ArtifactEnd = $null
$CaseManifestBeforeBuild = $null
$CaseManifestAfterBuild = $null
$CaseManifestAfterRun = $null
$CaseGitBeforeBuild = $null
$CaseGitAfterBuild = $null
$CaseGitAfterRun = $null
$DependencyLock = $null
$RuntimeVersions = $null
$StartCommit = $null
$EndCommit = $null
$TrackedChanges = ""
$GauntletExit = 3
$Failure = $null
$Violations = @()
$Status = "invalidated"
$StartedAt = (Get-Date).ToUniversalTime().ToString("o")
$WorktreeCreated = $false
$Aggregate = $null
$AggregateHash = $null
$AggregateParseAttempted = $false

try {
  New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null
  $HarnessGitStart = Get-CanaryGitPathState -RepositoryRoot $Root -RelativePaths ($HarnessPaths | ForEach-Object { "scripts/$_" })
  if (@($HarnessGitStart.changes).Count -gt 0) {
    throw "Evaluator harness source is not a clean committed tree: $($HarnessGitStart.changes -join '; ')"
  }
  $HarnessSourceStart = Get-CanaryFileManifest -Root $PSScriptRoot -RelativePaths $HarnessPaths
  New-Item -ItemType Directory -Force -Path $HarnessSnapshot | Out-Null
  foreach ($HarnessPath in $HarnessPaths) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $HarnessPath) -Destination (Join-Path $HarnessSnapshot $HarnessPath)
  }
  $HarnessStart = Get-CanaryFileManifest -Root $HarnessSnapshot -RelativePaths $HarnessPaths
  if ($HarnessStart.aggregateSha256 -ne $HarnessSourceStart.aggregateSha256) {
    throw "Evaluator harness snapshot does not match its committed source bytes."
  }
  # Mark cleanup responsibility before invoking git: worktree creation can
  # succeed and a subsequent validation can still throw.
  $WorktreeCreated = $true
  $Worktree = New-IsolatedCanaryWorktree `
    -RepositoryRoot $Root `
    -Commit $PinnedCommit `
    -Destination $Worktree
  $StartCommit = Resolve-CanaryCommit -RepositoryRoot $Worktree -Commit HEAD
  if ($StartCommit -ne $PinnedCommit) {
    throw "Pinned worktree began at $StartCommit instead of $PinnedCommit."
  }

  # The detached worktree may inherit neither ordinary untracked nor ignored
  # files from a prior run. Clean the entire case tree before measuring it,
  # then bind every byte (not merely git-tracked inputs) before any build or
  # provider work can execute.
  $PreviousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $CaseCleanOutput = (& git -C $Worktree clean -ffdx -- gauntlet/cases 2>&1 | Out-String).Trim()
  }
  finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to clean the disposable gauntlet case tree: $CaseCleanOutput"
  }
  $CaseGitBeforeBuild = Get-CanaryGitPathState -RepositoryRoot $Worktree -RelativePaths @("gauntlet/cases")
  if (@($CaseGitBeforeBuild.changes).Count -gt 0) {
    throw "Disposable gauntlet case tree is not clean before build: $($CaseGitBeforeBuild.changes -join '; ')"
  }
  $CaseManifestBeforeBuild = Get-CanaryFileManifest -Root (Join-Path $Worktree "gauntlet\cases")

  $NodeNpm = Get-CanaryNodeAndNpmEntrypoint
  $BuildEnvironment = Get-CanaryProcessEnvironment
  $EmptyNpmConfig = Join-Path $RunDirectory "empty.npmrc"
  [IO.File]::WriteAllText($EmptyNpmConfig, "", [Text.UTF8Encoding]::new($false))
  $BuildEnvironment["npm_config_userconfig"] = $EmptyNpmConfig
  $BuildEnvironment["npm_config_cache"] = Join-Path $RunDirectory "npm-cache"
  $BuildEnvironment["npm_config_ignore_scripts"] = "true"
  $BuildEnvironment["npm_config_audit"] = "false"
  $BuildEnvironment["npm_config_fund"] = "false"
  $InstallProcess = Invoke-CanaryUtf8Process `
    -FilePath $NodeNpm.node `
    -ArgumentList @($NodeNpm.npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund") `
    -Environment $BuildEnvironment `
    -WorkingDirectory $Worktree `
    -TimeoutMs 1200000
  if (-not [string]::IsNullOrWhiteSpace($InstallProcess.stdout)) { Write-Host $InstallProcess.stdout.TrimEnd() }
  if (-not [string]::IsNullOrWhiteSpace($InstallProcess.stderr)) { Write-Host $InstallProcess.stderr.TrimEnd() }
  if ($InstallProcess.exitCode -ne 0) { throw "npm ci failed with exit code $($InstallProcess.exitCode)." }
  $BuildProcess = Invoke-CanaryUtf8Process `
    -FilePath $NodeNpm.node `
    -ArgumentList @($NodeNpm.npmCli, "run", "build") `
    -Environment $BuildEnvironment `
    -WorkingDirectory $Worktree `
    -TimeoutMs 600000
  if (-not [string]::IsNullOrWhiteSpace($BuildProcess.stdout)) { Write-Host $BuildProcess.stdout.TrimEnd() }
  if (-not [string]::IsNullOrWhiteSpace($BuildProcess.stderr)) { Write-Host $BuildProcess.stderr.TrimEnd() }
  if ($BuildProcess.exitCode -ne 0) { throw "isolated build failed with exit code $($BuildProcess.exitCode)." }

  $CaseManifestAfterBuild = Get-CanaryFileManifest -Root (Join-Path $Worktree "gauntlet\cases")
  $CaseGitAfterBuild = Get-CanaryGitPathState -RepositoryRoot $Worktree -RelativePaths @("gauntlet/cases")
  if ($CaseManifestAfterBuild.aggregateSha256 -ne $CaseManifestBeforeBuild.aggregateSha256 `
    -or @($CaseGitAfterBuild.changes).Count -gt 0) {
    throw "Gauntlet case bytes drifted during the isolated build; refusing provider execution."
  }

  $ArtifactStart = Get-CanaryFileManifest -Root (Join-Path $Worktree "dist")
  if ($ArtifactStart.fileCount -eq 0) {
    throw "The isolated build produced no files under '$Worktree\dist'."
  }
  $DependencyLock = Get-CanaryFileManifest -Root $Worktree -RelativePaths @("package-lock.json")
  $NodeVersionProcess = Invoke-CanaryUtf8Process -FilePath $NodeNpm.node -ArgumentList @("--version") `
    -Environment $BuildEnvironment -WorkingDirectory $Worktree -TimeoutMs 30000
  $NpmVersionProcess = Invoke-CanaryUtf8Process -FilePath $NodeNpm.node -ArgumentList @($NodeNpm.npmCli, "--version") `
    -Environment $BuildEnvironment -WorkingDirectory $Worktree -TimeoutMs 30000
  if ($NodeVersionProcess.exitCode -ne 0 -or $NpmVersionProcess.exitCode -ne 0) {
    throw "Unable to capture sanitized Node/npm runtime versions."
  }
  $RuntimeVersions = [pscustomobject]@{
    node = $NodeVersionProcess.stdout.Trim()
    npm = $NpmVersionProcess.stdout.Trim()
  }

  if ($InfrastructureProbe) {
    $ProbeAggregate = [pscustomobject]@{
      version = 1
      probe = $true
      evidenceBoundary = New-CanaryEvidenceBoundary -Purpose "infrastructure-boundary-probe"
      pinnedCommit = $PinnedCommit
      isolatedBuildHash = $ArtifactStart.aggregateSha256
      completedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-CanaryJson -InputObject $ProbeAggregate -Path $AggregateFile -Depth 6
    $GauntletExit = 0
  }
  else {
    # Provider material enters the process only after install/build/artifact
    # binding is complete. The pinned build therefore cannot read the key.
    Import-VanguardCredential -Provider $Provider -Root $Root
    $ShellPath = (Get-Process -Id $PID).Path
    $RunnerArguments = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $HarnessSnapshot "run-private-gauntlet.ps1"),
      "-Provider", $Provider,
      "-Model", $Model,
      "-EngineRoot", $Worktree,
      "-OutputPath", $AggregateFile,
      "-SkipBuild"
    )
    if ($CaseId.Count -gt 0) {
      $CaseJson = ConvertTo-Json -Compress -InputObject @($CaseId)
      $CasePayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($CaseJson))
      $RunnerArguments += @("-CaseIdJsonBase64", $CasePayload)
    }
    & $ShellPath @RunnerArguments
    $GauntletExit = $LASTEXITCODE
  }

  $CaseManifestAfterRun = Get-CanaryFileManifest -Root (Join-Path $Worktree "gauntlet\cases")
  $CaseGitAfterRun = Get-CanaryGitPathState -RepositoryRoot $Worktree -RelativePaths @("gauntlet/cases")

  $EndCommit = Resolve-CanaryCommit -RepositoryRoot $Worktree -Commit HEAD
  $ArtifactEnd = Get-CanaryFileManifest -Root (Join-Path $Worktree "dist")
  $HarnessEnd = Get-CanaryFileManifest -Root $HarnessSnapshot -RelativePaths $HarnessPaths
  $HarnessSourceEnd = Get-CanaryFileManifest -Root $PSScriptRoot -RelativePaths $HarnessPaths
  $HarnessGitEnd = Get-CanaryGitPathState -RepositoryRoot $Root -RelativePaths ($HarnessPaths | ForEach-Object { "scripts/$_" })
  $TrackedChanges = (& git -C $Worktree status --porcelain --untracked-files=all | Out-String).Trim()
  $Violations = @(Get-CanaryInvariantViolations `
    -ExpectedCommit $PinnedCommit `
    -ActualCommit $EndCommit `
    -ExpectedArtifactHash $ArtifactStart.aggregateSha256 `
    -ActualArtifactHash $ArtifactEnd.aggregateSha256 `
    -ExpectedHarnessHash $HarnessStart.aggregateSha256 `
    -ActualHarnessHash $HarnessEnd.aggregateSha256 `
    -TrackedChanges $TrackedChanges `
    -AggregateExists (Test-Path -LiteralPath $AggregateFile -PathType Leaf))
  if ($HarnessGitStart.commit -ne $HarnessGitEnd.commit) {
    $Violations += "evaluator harness source commit drift: expected $($HarnessGitStart.commit), observed $($HarnessGitEnd.commit)"
  }
  if (@($HarnessGitEnd.changes).Count -gt 0) {
    $Violations += "evaluator harness source gained tracked or untracked changes: $($HarnessGitEnd.changes -join '; ')"
  }
  if ($HarnessSourceStart.aggregateSha256 -ne $HarnessSourceEnd.aggregateSha256) {
    $Violations += "evaluator harness source byte drift: expected $($HarnessSourceStart.aggregateSha256), observed $($HarnessSourceEnd.aggregateSha256)"
  }
  if ($CaseManifestBeforeBuild.aggregateSha256 -ne $CaseManifestAfterBuild.aggregateSha256) {
    $Violations += "gauntlet case byte drift during build: expected $($CaseManifestBeforeBuild.aggregateSha256), observed $($CaseManifestAfterBuild.aggregateSha256)"
  }
  if ($CaseManifestBeforeBuild.aggregateSha256 -ne $CaseManifestAfterRun.aggregateSha256) {
    $Violations += "gauntlet case byte drift during run: expected $($CaseManifestBeforeBuild.aggregateSha256), observed $($CaseManifestAfterRun.aggregateSha256)"
  }
  if (@($CaseGitAfterBuild.changes).Count -gt 0) {
    $Violations += "gauntlet case tree gained changes during build: $($CaseGitAfterBuild.changes -join '; ')"
  }
  if (@($CaseGitAfterRun.changes).Count -gt 0) {
    $Violations += "gauntlet case tree gained changes during run: $($CaseGitAfterRun.changes -join '; ')"
  }

  if (Test-Path -LiteralPath $AggregateFile -PathType Leaf) {
    $AggregateParseAttempted = $true
    try {
      $Aggregate = Read-CanaryUtf8Text -Path $AggregateFile | ConvertFrom-Json
      $AggregateHash = (Get-FileHash -LiteralPath $AggregateFile -Algorithm SHA256).Hash.ToLowerInvariant()
      $Violations += @(Get-CanaryAggregateViolations `
        -Aggregate $Aggregate `
        -InfrastructureProbe ([bool]$InfrastructureProbe) `
        -PinnedCommit $PinnedCommit `
        -ArtifactHash $ArtifactStart.aggregateSha256 `
        -Provider $Provider `
        -Model $Model `
        -EvaluationExitCode $GauntletExit `
        -RequestedCaseIds @($CaseId))
    }
    catch {
      $Violations += "explicit aggregate is not valid JSON: $($_.Exception.Message)"
    }
  }

  if ($Violations.Count -eq 0) {
    $Status = if ($InfrastructureProbe) { "infrastructure_probe" } else { "valid" }
  }
  else {
    $GauntletExit = 3
  }
}
catch {
  $Failure = $_.Exception.Message
  $Violations += "run did not complete inside the reproducibility boundary: $Failure"
  $GauntletExit = 3
}
finally {
  if ($WorktreeCreated -and (Test-Path -LiteralPath (Join-Path $Worktree "gauntlet\cases") -PathType Container) `
    -and $null -ne $CaseManifestBeforeBuild -and $null -eq $CaseManifestAfterRun) {
    try {
      $CaseManifestAfterRun = Get-CanaryFileManifest -Root (Join-Path $Worktree "gauntlet\cases")
      $CaseGitAfterRun = Get-CanaryGitPathState -RepositoryRoot $Worktree -RelativePaths @("gauntlet/cases")
      if ($CaseManifestBeforeBuild.aggregateSha256 -ne $CaseManifestAfterRun.aggregateSha256) {
        $Violations += "gauntlet case byte drift before aborted run cleanup: expected $($CaseManifestBeforeBuild.aggregateSha256), observed $($CaseManifestAfterRun.aggregateSha256)"
      }
      if (@($CaseGitAfterRun.changes).Count -gt 0) {
        $Violations += "gauntlet case tree gained changes before aborted run cleanup: $($CaseGitAfterRun.changes -join '; ')"
      }
    }
    catch {
      $Violations += "unable to bind gauntlet case bytes before cleanup: $($_.Exception.Message)"
    }
  }
  if ($WorktreeCreated) {
    try {
      Remove-IsolatedCanaryWorktree `
        -RepositoryRoot $Root `
        -Destination $Worktree `
        -ExpectedPrefix $WorktreeBase
    }
    catch {
      $Violations += "isolated worktree cleanup failed: $($_.Exception.Message)"
      $Status = "invalidated"
      $GauntletExit = 3
    }
  }

  try {
    if (-not $AggregateParseAttempted -and (Test-Path -LiteralPath $AggregateFile -PathType Leaf)) {
      $AggregateParseAttempted = $true
      try {
        $Aggregate = Read-CanaryUtf8Text -Path $AggregateFile | ConvertFrom-Json
        $AggregateHash = (Get-FileHash -LiteralPath $AggregateFile -Algorithm SHA256).Hash.ToLowerInvariant()
      }
      catch {
        $Violations += "explicit aggregate is not valid JSON: $($_.Exception.Message)"
        $Status = "invalidated"
        $GauntletExit = 3
      }
    }
    $HarnessCommitStart = if ($null -eq $HarnessGitStart) { $null } else { $HarnessGitStart.commit }
    $HarnessCommitEnd = if ($null -eq $HarnessGitEnd) { $null } else { $HarnessGitEnd.commit }
    $HarnessChangesStart = [object[]]@()
    $HarnessChangesEnd = [object[]]@()
    if ($null -ne $HarnessGitStart) { $HarnessChangesStart = [object[]]@($HarnessGitStart.changes) }
    if ($null -ne $HarnessGitEnd) { $HarnessChangesEnd = [object[]]@($HarnessGitEnd.changes) }
    $EvidencePurpose = if ($InfrastructureProbe) { "infrastructure-boundary-probe" } else { "regression-diagnostic" }
    $Wrapped = [pscustomobject]@{
      schemaVersion = 4
      layer = "development-canary"
      evidenceBoundary = New-CanaryEvidenceBoundary -Purpose $EvidencePurpose
      status = $Status
      phase = $Phase
      runId = $RunId
      provider = if ($InfrastructureProbe) { $null } else { $Provider }
      model = if ($InfrastructureProbe) { $null } else { $Model }
      requestedCaseIds = @($CaseId)
      requestedCommit = $Commit
      pinnedCommit = $PinnedCommit
      sourceCommitStart = $StartCommit
      sourceCommitEnd = $EndCommit
      startedAt = $StartedAt
      recordedAt = (Get-Date).ToUniversalTime().ToString("o")
      evaluationExitCode = $GauntletExit
      failure = $Failure
      invariantViolations = @($Violations)
      isolation = [pscustomobject]@{
        detachedWorktree = $Worktree
        dependencyInstall = "npm ci --ignore-scripts --no-audit --no-fund"
        dependencyLock = $DependencyLock
        runtimeVersions = $RuntimeVersions
        aggregatePath = $AggregateFile
        aggregateSha256 = $AggregateHash
        evaluatorHarnessSnapshot = $HarnessSnapshot
      }
      evaluatorHarnessSource = [pscustomobject]@{
        repositoryRoot = $Root
        commitStart = $HarnessCommitStart
        commitEnd = $HarnessCommitEnd
        changesStart = $HarnessChangesStart
        changesEnd = $HarnessChangesEnd
        manifestStart = $HarnessSourceStart
        manifestEnd = $HarnessSourceEnd
      }
      evaluatorHarnessStart = $HarnessStart
      evaluatorHarnessEnd = $HarnessEnd
      builtArtifactsStart = $ArtifactStart
      builtArtifactsEnd = $ArtifactEnd
      caseBinding = [pscustomobject]@{
        gitBeforeBuild = $CaseGitBeforeBuild
        gitAfterBuild = $CaseGitAfterBuild
        gitAfterRun = $CaseGitAfterRun
        manifestBeforeBuild = $CaseManifestBeforeBuild
        manifestAfterBuild = $CaseManifestAfterBuild
        manifestAfterRun = $CaseManifestAfterRun
      }
      result = $Aggregate
    }
    New-Item -ItemType Directory -Force -Path $ResolvedResultsRoot | Out-Null
    Write-CanaryJson -InputObject $Wrapped -Path $CanaryFile -Depth 20
  }
  finally {
    $Lock.Dispose()
  }
}

if ($Status -eq "invalidated") {
  Write-Host "Visible development diagnostic INVALIDATED - not Phase 13 certification evidence: $CanaryFile" -ForegroundColor Red
  foreach ($Violation in $Violations) { Write-Host "  - $Violation" -ForegroundColor Red }
}
elseif ($Status -eq "infrastructure_probe") {
  Write-Host "Visible development infrastructure probe passed - not Phase 13 certification evidence: $CanaryFile" -ForegroundColor Green
}
else {
  Write-Host "Visible development diagnostic recorded from pinned commit $PinnedCommit - not Phase 13 certification evidence: $CanaryFile" -ForegroundColor Green
}
exit $GauntletExit
