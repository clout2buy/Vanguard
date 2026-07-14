Set-StrictMode -Version Latest

function Get-CanaryOptionalProperty {
  param(
    [Parameter(Mandatory = $true)]$InputObject,
    [Parameter(Mandatory = $true)][string]$Name,
    $Default = $null
  )

  if ($null -eq $InputObject) {
    throw "Cannot read optional property '$Name' from a null object."
  }
  if ($Name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
    throw "Optional property name is invalid: $Name"
  }
  $Property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $Property) { return $Default }
  return $Property.Value
}

function Write-CanaryJson {
  param(
    [Parameter(Mandatory = $true)]$InputObject,
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Depth = 20
  )

  $ResolvedPath = [IO.Path]::GetFullPath($Path)
  $Parent = Split-Path -Parent $ResolvedPath
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $Json = $InputObject | ConvertTo-Json -Depth $Depth
  [IO.File]::WriteAllText($ResolvedPath, $Json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Resolve-CanaryCommit {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$Commit
  )

  $PreviousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $Resolved = (& git -C $RepositoryRoot rev-parse --verify "$Commit`^{commit}" 2>&1 | Out-String).Trim()
  }
  finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
  if ($LASTEXITCODE -ne 0 -or $Resolved -notmatch "^[0-9a-fA-F]{40}$") {
    throw "Unable to resolve canary commit '$Commit': $Resolved"
  }
  return $Resolved.ToLowerInvariant()
}

function Get-CanaryGitPathState {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )

  $Commit = Resolve-CanaryCommit -RepositoryRoot $RepositoryRoot -Commit HEAD
  $Arguments = @(
    "-C", [IO.Path]::GetFullPath($RepositoryRoot),
    "status", "--porcelain=v1", "--untracked-files=all", "--"
  ) + $RelativePaths
  $PreviousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $Output = (& git @Arguments 2>&1 | Out-String).Trim()
  }
  finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect evaluator harness source state: $Output"
  }
  return [pscustomobject]@{
    commit = $Commit
    changes = if ([string]::IsNullOrWhiteSpace($Output)) { @() } else { @($Output -split "`r?`n") }
  }
}

function Get-CanaryFileManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$RelativePaths = @()
  )

  $ResolvedRoot = [IO.Path]::GetFullPath($Root)
  $Files = @()
  if ($RelativePaths.Count -gt 0) {
    foreach ($RelativePath in $RelativePaths) {
      $Candidate = Join-Path $ResolvedRoot $RelativePath
      if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        throw "Manifest input is missing: $Candidate"
      }
      $Files += Get-Item -LiteralPath $Candidate
    }
  }
  elseif (Test-Path -LiteralPath $ResolvedRoot -PathType Container) {
    $Files = @(Get-ChildItem -LiteralPath $ResolvedRoot -File -Recurse | Sort-Object FullName)
  }

  $Entries = @()
  foreach ($File in $Files) {
    $FullName = [IO.Path]::GetFullPath($File.FullName)
    if ($RelativePaths.Count -gt 0) {
      $Relative = $FullName.Substring($ResolvedRoot.TrimEnd('\', '/').Length).TrimStart('\', '/')
    }
    else {
      $Relative = $FullName.Substring($ResolvedRoot.TrimEnd('\', '/').Length).TrimStart('\', '/')
    }
    $Entries += [pscustomobject]@{
      path = $Relative.Replace('\', '/')
      bytes = [int64]$File.Length
      sha256 = (Get-FileHash -LiteralPath $FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }

  $Canonical = ($Entries | ForEach-Object { "$($_.path)`t$($_.bytes)`t$($_.sha256)" }) -join "`n"
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Digest = $Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical))
    $Aggregate = ([BitConverter]::ToString($Digest) -replace "-", "").ToLowerInvariant()
  }
  finally {
    $Hasher.Dispose()
  }

  return [pscustomobject]@{
    root = $ResolvedRoot
    fileCount = $Entries.Count
    aggregateSha256 = $Aggregate
    files = $Entries
  }
}

function Enter-CanaryLock {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  $Parent = Split-Path -Parent $LockPath
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  try {
    $Stream = [IO.FileStream]::new(
      $LockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::DeleteOnClose
    )
    $Stream.SetLength(0)
    $Payload = [Text.Encoding]::UTF8.GetBytes("pid=$PID`nstarted=$((Get-Date).ToUniversalTime().ToString('o'))`n")
    $Stream.Write($Payload, 0, $Payload.Length)
    $Stream.Flush($true)
    return $Stream
  }
  catch {
    throw "Another Gate Zero canary owns the exclusive lock '$LockPath'. $($_.Exception.Message)"
  }
}

function New-IsolatedCanaryWorktree {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $ResolvedDestination = [IO.Path]::GetFullPath($Destination)
  if (Test-Path -LiteralPath $ResolvedDestination) {
    throw "Refusing to reuse an existing canary worktree path: $ResolvedDestination"
  }
  $PreviousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $Output = (& git -C $RepositoryRoot worktree add --detach $ResolvedDestination $Commit 2>&1 | Out-String).Trim()
  }
  finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create detached canary worktree: $Output"
  }
  $Actual = Resolve-CanaryCommit -RepositoryRoot $ResolvedDestination -Commit HEAD
  if ($Actual -ne $Commit.ToLowerInvariant()) {
    throw "Detached worktree resolved to $Actual instead of pinned commit $Commit."
  }
  return $ResolvedDestination
}

function Remove-IsolatedCanaryWorktree {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedPrefix
  )

  $ResolvedDestination = [IO.Path]::GetFullPath($Destination)
  $ResolvedPrefix = [IO.Path]::GetFullPath($ExpectedPrefix).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $ResolvedDestination.StartsWith($ResolvedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove canary worktree outside '$ResolvedPrefix': $ResolvedDestination"
  }
  if ((Split-Path -Leaf $ResolvedDestination) -notlike "vanguard-canary-*") {
    throw "Refusing to remove a path without the vanguard-canary prefix: $ResolvedDestination"
  }

  $PreviousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & git -C $RepositoryRoot worktree remove --force $ResolvedDestination 2>&1 | Out-Null
  }
  finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
  if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $ResolvedDestination)) {
    throw "git worktree remove failed for $ResolvedDestination."
  }
}

function Get-CanaryInvariantViolations {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedCommit,
    [Parameter(Mandatory = $true)][string]$ActualCommit,
    [Parameter(Mandatory = $true)][string]$ExpectedArtifactHash,
    [Parameter(Mandatory = $true)][string]$ActualArtifactHash,
    [Parameter(Mandatory = $true)][string]$ExpectedHarnessHash,
    [Parameter(Mandatory = $true)][string]$ActualHarnessHash,
    [string]$TrackedChanges = "",
    [bool]$AggregateExists = $true
  )

  $Violations = @()
  if ($ActualCommit -ne $ExpectedCommit) {
    $Violations += "commit drift: expected $ExpectedCommit, observed $ActualCommit"
  }
  if ($ActualArtifactHash -ne $ExpectedArtifactHash) {
    $Violations += "built artifact drift: expected $ExpectedArtifactHash, observed $ActualArtifactHash"
  }
  if ($ActualHarnessHash -ne $ExpectedHarnessHash) {
    $Violations += "evaluator harness drift: expected $ExpectedHarnessHash, observed $ActualHarnessHash"
  }
  if (-not [string]::IsNullOrWhiteSpace($TrackedChanges)) {
    $Violations += "pinned worktree gained tracked changes: $TrackedChanges"
  }
  if (-not $AggregateExists) {
    $Violations += "the gauntlet did not produce its explicit aggregate output"
  }
  return $Violations
}

function Get-CanaryAggregateViolations {
  param(
    [Parameter(Mandatory = $true)]$Aggregate,
    [Parameter(Mandatory = $true)][bool]$InfrastructureProbe,
    [Parameter(Mandatory = $true)][string]$PinnedCommit,
    [Parameter(Mandatory = $true)][string]$ArtifactHash,
    [string]$Provider = "",
    [string]$Model = "",
    [int]$EvaluationExitCode = 0,
    [string[]]$RequestedCaseIds = @()
  )

  $Violations = @()
  try {
    if ($InfrastructureProbe) {
      if ($Aggregate.version -ne 1 -or $Aggregate.probe -ne $true) {
        $Violations += "infrastructure probe aggregate has the wrong schema"
      }
      if ($Aggregate.pinnedCommit -ne $PinnedCommit -or $Aggregate.isolatedBuildHash -ne $ArtifactHash) {
        $Violations += "infrastructure probe aggregate is not bound to the pinned build"
      }
      if ($EvaluationExitCode -ne 0) {
        $Violations += "infrastructure probe returned exit code $EvaluationExitCode"
      }
      return $Violations
    }

    if ($Aggregate.version -ne 8) { $Violations += "gauntlet aggregate version is not 8" }
    if ($Aggregate.provider -ne $Provider -or $Aggregate.model -ne $Model) {
      $Violations += "gauntlet aggregate provider/model does not match the request"
    }
    $Cases = @($Aggregate.cases)
    if ($Cases.Count -lt 1 -or $Aggregate.total -ne $Cases.Count) {
      $Violations += "gauntlet aggregate total does not match its case records"
    }
    $Ids = @($Cases | ForEach-Object { [string]$_.id })
    if (@($Ids | Select-Object -Unique).Count -ne $Ids.Count) {
      $Violations += "gauntlet aggregate contains duplicate case ids"
    }
    if ($RequestedCaseIds.Count -gt 0) {
      $ExpectedIds = @($RequestedCaseIds | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
      $ActualIds = @($Ids | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
      if (($ExpectedIds -join "`n") -ne ($ActualIds -join "`n")) {
        $Violations += "gauntlet aggregate case ids do not match the exact requested selection"
      }
    }

    $Passed = @($Cases | Where-Object { $_.verified -eq $true }).Count
    $InfrastructureErrors = @($Cases | Where-Object { $_.classification -eq "infrastructure_error" }).Count
    $EngineErrors = @($Cases | Where-Object { $_.classification -eq "engine_error" }).Count
    $Evaluated = $Cases.Count - $InfrastructureErrors
    if ($Aggregate.passed -ne $Passed -or $Aggregate.infrastructureErrors -ne $InfrastructureErrors `
      -or $Aggregate.engineErrors -ne $EngineErrors -or $Aggregate.evaluated -ne $Evaluated) {
      $Violations += "gauntlet aggregate summary counts do not match its case records"
    }
    $ExpectedScore = if ($Cases.Count -eq 0) { 0.0 } else { [double]$Passed / [double]$Cases.Count }
    if ([math]::Abs([double]$Aggregate.score - $ExpectedScore) -gt 0.000000001) {
      $Violations += "gauntlet aggregate score is not passed/total"
    }
    $ExpectedComparable = $InfrastructureErrors -eq 0
    if ($Aggregate.complete -ne $ExpectedComparable -or $Aggregate.comparable -ne $ExpectedComparable) {
      $Violations += "gauntlet aggregate completeness/comparability flags are inconsistent"
    }

    foreach ($Case in $Cases) {
      if ($Case.verified -isnot [bool] -or $Case.capabilityEligible -isnot [bool]) {
        $Violations += "case '$($Case.id)' has non-boolean verification fields"
        continue
      }
      if ($Case.classification -notin @("verified", "capability_failure", "infrastructure_error", "engine_error")) {
        $Violations += "case '$($Case.id)' has an unknown classification"
      }
      if ($Case.verified) {
        if ($Case.score -ne 1 -or $Case.classification -ne "verified" -or $Case.capabilityEligible -ne $true `
          -or $Case.exitCode -ne 0 -or $Case.evaluator.bindingPassed -ne $true `
          -or $Case.evaluator.integrityPassed -ne $true -or $Case.evaluator.graderPassed -ne $true `
          -or (@($Case.evaluator.violations).Count -ne 0)) {
          $Violations += "verified case '$($Case.id)' lacks complete independent evidence"
        }
      }
      else {
        if ($Case.score -ne 0 -or $Case.classification -eq "verified") {
          $Violations += "non-verified case '$($Case.id)' does not score zero"
        }
        if (($Case.classification -eq "infrastructure_error") -ne ($Case.capabilityEligible -eq $false)) {
          $Violations += "case '$($Case.id)' has inconsistent infrastructure eligibility"
        }
      }
    }

    $BindingFailures = @($Cases | Where-Object { $_.evaluator.bindingPassed -ne $true }).Count
    $IntegrityFailures = @($Cases | Where-Object { $_.evaluator.integrityPassed -ne $true }).Count
    $GraderFailures = @($Cases | Where-Object { $_.evaluator.graderPassed -ne $true }).Count
    if ($Aggregate.externalEvaluation.bindingFailures -ne $BindingFailures `
      -or $Aggregate.externalEvaluation.integrityFailures -ne $IntegrityFailures `
      -or $Aggregate.externalEvaluation.graderFailures -ne $GraderFailures) {
      $Violations += "gauntlet external-evaluation summary does not match its case evidence"
    }

    $ExpectedExitCode = if ($InfrastructureErrors -gt 0) { 2 } elseif ($Passed -ne $Cases.Count) { 1 } else { 0 }
    if ($EvaluationExitCode -ne $ExpectedExitCode) {
      $Violations += "gauntlet exit code $EvaluationExitCode does not match aggregate outcome $ExpectedExitCode"
    }
  }
  catch {
    $Violations += "gauntlet aggregate schema validation failed: $($_.Exception.Message)"
  }
  return $Violations
}
