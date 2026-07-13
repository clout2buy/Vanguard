param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath($RepositoryRoot)
. (Join-Path $Root "scripts\canary-support.ps1")

function Assert-CanaryTest {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "vanguard-canary-support-$([guid]::NewGuid().ToString('N'))"
$Worktree = Join-Path $TemporaryRoot "vanguard-canary-boundary-test"
$Lock = $null
$Created = $false

try {
  New-Item -ItemType Directory -Force -Path $TemporaryRoot | Out-Null
  $Pinned = Resolve-CanaryCommit -RepositoryRoot $Root -Commit "HEAD~1"
  $Active = Resolve-CanaryCommit -RepositoryRoot $Root -Commit "HEAD"
  Assert-CanaryTest ($Pinned -ne $Active) "The pinning fixture requires HEAD~1 to differ from HEAD."

  $Created = $true
  $CreatedPath = New-IsolatedCanaryWorktree -RepositoryRoot $Root -Commit $Pinned -Destination $Worktree
  $Observed = Resolve-CanaryCommit -RepositoryRoot $CreatedPath -Commit HEAD
  Assert-CanaryTest ($Observed -eq $Pinned) "The detached worktree did not stay on the requested historical commit."
  Assert-CanaryTest ($Observed -ne $Active) "The detached worktree followed the active branch instead of the pin."

  $Dist = Join-Path $CreatedPath "dist-boundary-fixture"
  New-Item -ItemType Directory -Force -Path $Dist | Out-Null
  Set-Content -LiteralPath (Join-Path $Dist "engine.js") -Value "before" -Encoding UTF8
  $Before = Get-CanaryFileManifest -Root $Dist
  Set-Content -LiteralPath (Join-Path $Dist "engine.js") -Value "after" -Encoding UTF8
  $After = Get-CanaryFileManifest -Root $Dist
  $ArtifactDrift = @(Get-CanaryInvariantViolations `
    -ExpectedCommit $Pinned -ActualCommit $Pinned `
    -ExpectedArtifactHash $Before.aggregateSha256 -ActualArtifactHash $After.aggregateSha256 `
    -ExpectedHarnessHash "same" -ActualHarnessHash "same")
  Assert-CanaryTest (($ArtifactDrift -join "`n") -match "built artifact drift") "Artifact mutation was not rejected."

  $CommitDrift = @(Get-CanaryInvariantViolations `
    -ExpectedCommit $Pinned -ActualCommit $Active `
    -ExpectedArtifactHash "same" -ActualArtifactHash "same" `
    -ExpectedHarnessHash "same" -ActualHarnessHash "same")
  Assert-CanaryTest (($CommitDrift -join "`n") -match "commit drift") "Commit mutation was not rejected."

  $HarnessDrift = @(Get-CanaryInvariantViolations `
    -ExpectedCommit $Pinned -ActualCommit $Pinned `
    -ExpectedArtifactHash "same" -ActualArtifactHash "same" `
    -ExpectedHarnessHash "before" -ActualHarnessHash "after")
  Assert-CanaryTest (($HarnessDrift -join "`n") -match "evaluator harness drift") "Harness mutation was not rejected."

  $LockPath = Join-Path $TemporaryRoot "exclusive.lock"
  $Lock = Enter-CanaryLock -LockPath $LockPath
  $SecondOwnerRejected = $false
  try {
    $Second = Enter-CanaryLock -LockPath $LockPath
    $Second.Dispose()
  }
  catch {
    $SecondOwnerRejected = $true
  }
  Assert-CanaryTest $SecondOwnerRejected "A second process handle acquired the exclusive canary lock."

  $VerifiedCase = [pscustomobject]@{
    id = "verified-case"
    verified = $true
    score = 1
    classification = "verified"
    capabilityEligible = $true
    exitCode = 0
    evaluator = [pscustomobject]@{
      bindingPassed = $true
      integrityPassed = $true
      graderPassed = $true
      violations = @()
    }
  }
  $ValidAggregate = [pscustomobject]@{
    version = 8
    provider = "deepseek"
    model = "fixture"
    passed = 1
    total = 1
    evaluated = 1
    infrastructureErrors = 0
    engineErrors = 0
    complete = $true
    comparable = $true
    score = 1.0
    externalEvaluation = [pscustomobject]@{
      bindingFailures = 0
      integrityFailures = 0
      graderFailures = 0
    }
    cases = @($VerifiedCase)
  }
  $ValidAggregateViolations = @(Get-CanaryAggregateViolations `
    -Aggregate $ValidAggregate -InfrastructureProbe $false `
    -PinnedCommit $Pinned -ArtifactHash "artifact" `
    -Provider "deepseek" -Model "fixture" -EvaluationExitCode 0 `
    -RequestedCaseIds @("verified-case"))
  Assert-CanaryTest ($ValidAggregateViolations.Count -eq 0) "A valid independently scored aggregate was rejected: $($ValidAggregateViolations -join '; ')"

  $InfrastructureCase = [pscustomobject]@{
    id = "infrastructure-case"
    verified = $false
    score = 0
    classification = "infrastructure_error"
    capabilityEligible = $false
    exitCode = 1
    evaluator = [pscustomobject]@{
      bindingPassed = $true
      integrityPassed = $true
      graderPassed = $false
      violations = @("provider unavailable")
    }
  }
  $InflatedAggregate = [pscustomobject]@{
    version = 8
    provider = "deepseek"
    model = "fixture"
    passed = 1
    total = 2
    evaluated = 1
    infrastructureErrors = 1
    engineErrors = 0
    complete = $false
    comparable = $false
    score = 1.0
    externalEvaluation = [pscustomobject]@{
      bindingFailures = 0
      integrityFailures = 0
      graderFailures = 1
    }
    cases = @($VerifiedCase, $InfrastructureCase)
  }
  $InflatedViolations = @(Get-CanaryAggregateViolations `
    -Aggregate $InflatedAggregate -InfrastructureProbe $false `
    -PinnedCommit $Pinned -ArtifactHash "artifact" `
    -Provider "deepseek" -Model "fixture" -EvaluationExitCode 2)
  Assert-CanaryTest (($InflatedViolations -join "`n") -match "passed/total") "Infrastructure exclusion inflated the headline score."

  Write-Output "Gate Zero support boundary assertions passed."
}
finally {
  if ($null -ne $Lock) { $Lock.Dispose() }
  if ($Created) {
    Remove-IsolatedCanaryWorktree `
      -RepositoryRoot $Root `
      -Destination $Worktree `
      -ExpectedPrefix $TemporaryRoot
  }
  if (Test-Path -LiteralPath $TemporaryRoot) {
    $ResolvedTemporary = [IO.Path]::GetFullPath($TemporaryRoot)
    $ResolvedSystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $ResolvedTemporary.StartsWith($ResolvedSystemTemp, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean a test path outside the system temp directory: $ResolvedTemporary"
    }
    Remove-Item -LiteralPath $ResolvedTemporary -Recurse -Force
  }
}
