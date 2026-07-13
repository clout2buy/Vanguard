Set-StrictMode -Version Latest

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
