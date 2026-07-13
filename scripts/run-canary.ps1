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

# Gate Zero Layer 1. The evaluator harness is the current committed script set,
# whose content hash is recorded and guarded for the duration of the run. The
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
  "canary-support.ps1",
  "credential.ps1"
)
$HarnessStart = Get-CanaryFileManifest -Root $PSScriptRoot -RelativePaths $HarnessPaths
$HarnessEnd = $null
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
      "-File", (Join-Path $PSScriptRoot "run-private-gauntlet.ps1"),
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
  $HarnessEnd = Get-CanaryFileManifest -Root $PSScriptRoot -RelativePaths $HarnessPaths
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

  if (Test-Path -LiteralPath $AggregateFile -PathType Leaf) {
    $AggregateParseAttempted = $true
    try {
      $Aggregate = Get-Content -Raw -LiteralPath $AggregateFile | ConvertFrom-Json
      $AggregateHash = (Get-FileHash -LiteralPath $AggregateFile -Algorithm SHA256).Hash.ToLowerInvariant()
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
    $Wrapped = [pscustomobject]@{
      schemaVersion = 2
      layer = "development-canary"
      status = $Status
      phase = $Phase
      runId = $RunId
      provider = if ($InfrastructureProbe) { $null } else { $Provider }
      model = if ($InfrastructureProbe) { $null } else { $Model }
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
