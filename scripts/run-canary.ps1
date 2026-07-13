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
$CanaryFile = Join-Path $ResolvedResultsRoot "canary-$SafePhase-$RunId.json"
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
  if (-not $InfrastructureProbe) {
    Import-VanguardCredential -Provider $Provider -Root $Root
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

  Push-Location $Worktree
  try {
    npm ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "isolated build failed with exit code $LASTEXITCODE." }
  }
  finally {
    Pop-Location
  }

  $ArtifactStart = Get-CanaryFileManifest -Root (Join-Path $Worktree "dist")
  if ($ArtifactStart.fileCount -eq 0) {
    throw "The isolated build produced no files under '$Worktree\dist'."
  }
  $DependencyLock = Get-CanaryFileManifest -Root $Worktree -RelativePaths @("package-lock.json")
  $RuntimeVersions = [pscustomobject]@{
    node = (& node --version | Out-String).Trim()
    npm = (& npm --version | Out-String).Trim()
  }

  if ($InfrastructureProbe) {
    $ProbeAggregate = [pscustomobject]@{
      version = 1
      probe = $true
      pinnedCommit = $PinnedCommit
      isolatedBuildHash = $ArtifactStart.aggregateSha256
      completedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    Write-CanaryJson -InputObject $ProbeAggregate -Path $AggregateFile -Depth 6
    $GauntletExit = 0
  }
  else {
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

  $EndCommit = Resolve-CanaryCommit -RepositoryRoot $Worktree -Commit HEAD
  $ArtifactEnd = Get-CanaryFileManifest -Root (Join-Path $Worktree "dist")
  $HarnessEnd = Get-CanaryFileManifest -Root $HarnessSnapshot -RelativePaths $HarnessPaths
  $HarnessSourceEnd = Get-CanaryFileManifest -Root $PSScriptRoot -RelativePaths $HarnessPaths
  $HarnessGitEnd = Get-CanaryGitPathState -RepositoryRoot $Root -RelativePaths ($HarnessPaths | ForEach-Object { "scripts/$_" })
  $TrackedChanges = (& git -C $Worktree status --porcelain --untracked-files=no | Out-String).Trim()
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

  if (Test-Path -LiteralPath $AggregateFile -PathType Leaf) {
    $AggregateParseAttempted = $true
    try {
      $Aggregate = Get-Content -Raw -LiteralPath $AggregateFile | ConvertFrom-Json
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
        $Aggregate = Get-Content -Raw -LiteralPath $AggregateFile | ConvertFrom-Json
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
    $Wrapped = [pscustomobject]@{
      schemaVersion = 3
      layer = "development-canary"
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
  Write-Host "Canary INVALIDATED: $CanaryFile" -ForegroundColor Red
  foreach ($Violation in $Violations) { Write-Host "  - $Violation" -ForegroundColor Red }
}
elseif ($Status -eq "infrastructure_probe") {
  Write-Host "Canary isolation probe passed: $CanaryFile" -ForegroundColor Green
}
else {
  Write-Host "Canary result recorded from pinned commit $PinnedCommit`: $CanaryFile" -ForegroundColor Green
}
exit $GauntletExit
