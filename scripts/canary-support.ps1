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

function Test-CanaryNonnegativeSafeInteger {
  param($Value)

  if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string]) { return $false }
  try {
    $Number = [double]$Value
    return -not [double]::IsNaN($Number) `
      -and -not [double]::IsInfinity($Number) `
      -and $Number -ge 0 `
      -and $Number -le 9007199254740991 `
      -and [math]::Floor($Number) -eq $Number
  }
  catch {
    return $false
  }
}

function New-CanaryEvidenceBoundary {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("regression-diagnostic", "infrastructure-boundary-probe")]
    [string]$Purpose
  )

  return [pscustomobject]@{
    layer = "development-canary"
    visibility = "developer-visible"
    graderBoundary = "candidate-hidden-developer-visible"
    purpose = $Purpose
    competitiveClaimEligible = $false
    phase13CertificationEligible = $false
  }
}

function Get-CanaryEvidenceBoundaryViolations {
  param(
    $EvidenceBoundary,

    [Parameter(Mandatory = $true)]
    [ValidateSet("regression-diagnostic", "infrastructure-boundary-probe")]
    [string]$ExpectedPurpose
  )

  $Violations = @()
  if ($null -eq $EvidenceBoundary -or $EvidenceBoundary -is [string] -or $EvidenceBoundary -is [ValueType]) {
    return @("canary evidence boundary is missing or malformed")
  }
  $ExpectedKeys = @(
    "competitiveClaimEligible",
    "graderBoundary",
    "layer",
    "phase13CertificationEligible",
    "purpose",
    "visibility"
  )
  $ActualKeys = @($EvidenceBoundary.PSObject.Properties.Name | Sort-Object)
  if (($ActualKeys -join "`n") -cne ($ExpectedKeys -join "`n")) {
    $Violations += "canary evidence boundary does not use the closed schema"
  }
  if ((Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "layer") -cne "development-canary" `
    -or (Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "visibility") -cne "developer-visible" `
    -or (Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "graderBoundary") -cne "candidate-hidden-developer-visible" `
    -or (Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "purpose") -cne $ExpectedPurpose) {
    $Violations += "canary evidence boundary classification is invalid"
  }
  $Competitive = Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "competitiveClaimEligible"
  $Phase13 = Get-CanaryOptionalProperty -InputObject $EvidenceBoundary -Name "phase13CertificationEligible"
  if ($Competitive -isnot [bool] -or $Competitive -ne $false `
    -or $Phase13 -isnot [bool] -or $Phase13 -ne $false) {
    $Violations += "visible development diagnostics cannot be competitive or Phase-13 certification evidence"
  }
  return $Violations
}

function Read-CanaryUtf8Text {
  param([Parameter(Mandatory = $true)][string]$Path)

  $ResolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
    throw "Canary UTF-8 input is not a file: $ResolvedPath"
  }
  try {
    # Windows PowerShell 5.1's Get-Content default is the active ANSI code
    # page. Sealed task bytes are UTF-8 and must reach the engine and the
    # independent evaluator as the same Unicode text.
    return [IO.File]::ReadAllText($ResolvedPath, [Text.UTF8Encoding]::new($false, $true))
  }
  catch [Text.DecoderFallbackException] {
    throw "Canary input is not valid UTF-8: $ResolvedPath"
  }
}

function Get-CanaryProcessEnvironment {
  param([string]$CredentialVariable = "")

  # Start from a deliberately small build/runtime surface. In particular, no
  # inherited NODE_* preload/cache knobs or VANGUARD_* feature switches can
  # change the candidate or evaluator behind the recorded run configuration.
  $Result = @{}
  $PathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  if ([string]::IsNullOrEmpty($PathValue)) {
    $PathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
  }
  if (-not [string]::IsNullOrEmpty($PathValue)) { $Result["PATH"] = $PathValue }
  $SystemRootValue = [Environment]::GetEnvironmentVariable("SystemRoot", "Process")
  if ([string]::IsNullOrEmpty($SystemRootValue)) {
    $SystemRootValue = [Environment]::GetEnvironmentVariable("SYSTEMROOT", "Process")
  }
  if (-not [string]::IsNullOrEmpty($SystemRootValue)) { $Result["SystemRoot"] = $SystemRootValue }
  foreach ($Name in @("PATHEXT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "JAVA_HOME")) {
    $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not [string]::IsNullOrEmpty($Value)) { $Result[$Name] = $Value }
  }
  if (-not [string]::IsNullOrWhiteSpace($CredentialVariable)) {
    if ($CredentialVariable -notmatch "^[A-Z][A-Z0-9_]*$") {
      throw "Canary credential variable name is invalid: $CredentialVariable"
    }
    $Credential = [Environment]::GetEnvironmentVariable($CredentialVariable, "Process")
    if ([string]::IsNullOrWhiteSpace($Credential)) {
      throw "Canary credential is unavailable in the process environment: $CredentialVariable"
    }
    $Result[$CredentialVariable] = $Credential
  }
  $Result["VANGUARD_DELEGATION_DEPTH"] = "0"
  $Result["VANGUARD_DELEGATION_MAX_DEPTH"] = "1"
  $Result["VANGUARD_DELEGATION_CONCURRENCY"] = "2"
  $Result["VANGUARD_DELEGATION_MAX_CHILDREN"] = "6"
  return $Result
}

function Get-CanaryNodeAndNpmEntrypoint {
  $NodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $NodePath = [IO.Path]::GetFullPath($NodeCommand.Source)
  $Candidates = @(
    (Join-Path (Split-Path -Parent $NodePath) "node_modules\npm\bin\npm-cli.js"),
    (Join-Path (Split-Path -Parent (Split-Path -Parent $NodePath)) "lib\node_modules\npm\bin\npm-cli.js")
  )
  $NpmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $NpmCommand) {
    $Candidates += Join-Path (Split-Path -Parent $NpmCommand.Source) "node_modules\npm\bin\npm-cli.js"
  }
  $NpmCli = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($NpmCli)) {
    throw "Unable to resolve npm-cli.js beside the selected Node runtime."
  }
  return [pscustomobject]@{
    node = $NodePath
    npmCli = [IO.Path]::GetFullPath($NpmCli)
  }
}

function ConvertTo-CanaryWindowsArgument {
  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Argument)

  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }
  $Builder = [Text.StringBuilder]::new()
  [void]$Builder.Append([char]34)
  $Backslashes = 0
  foreach ($Character in $Argument.ToCharArray()) {
    if ([int]$Character -eq 92) {
      $Backslashes += 1
      continue
    }
    if ([int]$Character -eq 34) {
      if ($Backslashes -gt 0) { [void]$Builder.Append([char]92, ($Backslashes * 2)) }
      [void]$Builder.Append([char]92)
      [void]$Builder.Append([char]34)
      $Backslashes = 0
      continue
    }
    if ($Backslashes -gt 0) { [void]$Builder.Append([char]92, $Backslashes) }
    [void]$Builder.Append($Character)
    $Backslashes = 0
  }
  if ($Backslashes -gt 0) { [void]$Builder.Append([char]92, ($Backslashes * 2)) }
  [void]$Builder.Append([char]34)
  return $Builder.ToString()
}

function Invoke-CanaryUtf8Process {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][hashtable]$Environment,
    [string]$WorkingDirectory = (Get-Location).Path,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 604800000)]
    [int]$TimeoutMs
  )

  $StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $StartInfo.FileName = $FilePath
  $StartInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  $Utf8 = [Text.UTF8Encoding]::new($false, $true)
  $StartInfo.StandardOutputEncoding = $Utf8
  $StartInfo.StandardErrorEncoding = $Utf8
  $StartInfo.EnvironmentVariables.Clear()
  foreach ($Name in $Environment.Keys) {
    $StartInfo.EnvironmentVariables[[string]$Name] = [string]$Environment[$Name]
  }

  if ($null -ne $StartInfo.PSObject.Properties["ArgumentList"]) {
    foreach ($Argument in $ArgumentList) { [void]$StartInfo.ArgumentList.Add($Argument) }
  }
  elseif ($PSVersionTable.PSEdition -eq "Desktop" -or [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $StartInfo.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-CanaryWindowsArgument -Argument $_ }) -join " ")
  }
  else {
    throw "This PowerShell runtime cannot pass an exact native argument vector."
  }

  $Process = [Diagnostics.Process]::new()
  $Process.StartInfo = $StartInfo
  try {
    if (-not $Process.Start()) { throw "Process failed to start: $FilePath" }
    $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
    $StderrTask = $Process.StandardError.ReadToEndAsync()
    $TimedOut = -not $Process.WaitForExit($TimeoutMs)
    if ($TimedOut) {
      # Process.Kill(entireProcessTree) is unavailable on the .NET Framework
      # hosted by Windows PowerShell 5.1. taskkill /T binds termination to the
      # still-live root PID and closes descendants that may hold redirected
      # stdout/stderr handles; using Kill() alone can leave this call hung.
      if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $TaskKill = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) "taskkill.exe"
        if (-not (Test-Path -LiteralPath $TaskKill -PathType Leaf)) {
          throw "Cannot terminate timed-out canary process tree because taskkill.exe is unavailable."
        }
        $PreviousErrorPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
          & $TaskKill /PID ([string]$Process.Id) /T /F 2>&1 | Out-Null
        }
        finally {
          $ErrorActionPreference = $PreviousErrorPreference
        }
      }
      elseif (-not $Process.HasExited) {
        $Process.Kill()
      }
      if (-not $Process.WaitForExit(10000)) {
        throw "Timed-out canary process tree did not terminate within the fixed shutdown grace period."
      }
    }
    # The parameterless wait flushes asynchronous redirected-stream events
    # after the bounded/termination wait; it returns immediately after exit.
    $Process.WaitForExit()
    $Stdout = $StdoutTask.GetAwaiter().GetResult()
    $Stderr = $StderrTask.GetAwaiter().GetResult()
    return [pscustomobject]@{
      exitCode = if ($TimedOut) { 124 } else { $Process.ExitCode }
      stdout = $Stdout
      stderr = $Stderr
      timedOut = $TimedOut
    }
  }
  finally {
    $Process.Dispose()
  }
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
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--"
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
  $Changes = [object[]]@()
  if (-not [string]::IsNullOrWhiteSpace($Output)) {
    $Changes = [object[]]@($Output -split "`r?`n")
  }
  return [pscustomobject]@{
    commit = $Commit
    # Assign a typed array instead of an inline empty pipeline expression.
    # Windows PowerShell 5.1 otherwise serializes AutomationNull as `{}` in
    # the evidence wrapper, violating the closed array schema.
    changes = $Changes
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
      $Files += Get-Item -Force -LiteralPath $Candidate
    }
  }
  elseif (Test-Path -LiteralPath $ResolvedRoot -PathType Container) {
    $Files = @(Get-ChildItem -Force -LiteralPath $ResolvedRoot -File -Recurse | Sort-Object FullName)
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
    $ExpectedPurpose = if ($InfrastructureProbe) { "infrastructure-boundary-probe" } else { "regression-diagnostic" }
    $EvidenceBoundary = Get-CanaryOptionalProperty -InputObject $Aggregate -Name "evidenceBoundary"
    $Violations += @(Get-CanaryEvidenceBoundaryViolations `
      -EvidenceBoundary $EvidenceBoundary `
      -ExpectedPurpose $ExpectedPurpose)
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

    if ($Aggregate.version -ne 9) { $Violations += "gauntlet aggregate version is not 9" }
    if ($null -ne $Aggregate.PSObject.Properties["externalEvaluation"]) {
      $Violations += "gauntlet aggregate uses the retired ambiguous externalEvaluation field"
    }
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

    $Trajectory = Get-CanaryOptionalProperty -InputObject $Aggregate -Name "trajectory"
    if ($null -eq $Trajectory -or $Trajectory -is [string] -or $Trajectory -is [ValueType]) {
      $Violations += "gauntlet aggregate trajectory is missing or malformed"
    }
    else {
      $TrajectoryFields = [ordered]@{
        totalSteps = "steps"
        toolFailures = "toolFailures"
        localTestFailures = "localTestFailures"
        testHarnessFailures = "testHarnessFailures"
        toolFrictionFailures = "toolFrictionFailures"
        verificationFailures = "verificationFailures"
        completionClaims = "completionClaims"
        policyBlocks = "policyBlocks"
        contextCompactions = "contextCompactions"
        contextProjections = "contextProjections"
      }
      foreach ($AggregateField in $TrajectoryFields.Keys) {
        $CaseField = $TrajectoryFields[$AggregateField]
        $AggregateValue = Get-CanaryOptionalProperty -InputObject $Trajectory -Name $AggregateField
        if (-not (Test-CanaryNonnegativeSafeInteger -Value $AggregateValue)) {
          $Violations += "gauntlet aggregate trajectory.$AggregateField is not a nonnegative safe integer"
          continue
        }
        [long]$ExpectedTotal = 0
        $CaseValuesValid = $true
        foreach ($Case in $Cases) {
          $CaseValue = Get-CanaryOptionalProperty -InputObject $Case -Name $CaseField
          if (-not (Test-CanaryNonnegativeSafeInteger -Value $CaseValue)) {
            $Violations += "case '$($Case.id)' metric $CaseField is not a nonnegative safe integer"
            $CaseValuesValid = $false
          }
          else {
            $ExpectedTotal += [long]$CaseValue
          }
        }
        if ($CaseValuesValid -and [long]$AggregateValue -ne $ExpectedTotal) {
          $Violations += "gauntlet aggregate trajectory.$AggregateField does not equal the case sum"
        }
      }
    }

    foreach ($Case in $Cases) {
      if ($null -ne $Case.PSObject.Properties["capabilityEligible"]) {
        $Violations += "case '$($Case.id)' uses the retired ambiguous capabilityEligible field"
      }
      if ($Case.verified -isnot [bool] -or $Case.canaryDenominatorEligible -isnot [bool]) {
        $Violations += "case '$($Case.id)' has non-boolean verification fields"
        continue
      }
      if ($Case.classification -notin @("verified", "capability_failure", "infrastructure_error", "engine_error")) {
        $Violations += "case '$($Case.id)' has an unknown classification"
      }
      if ($Case.verified) {
        if ($Case.score -ne 1 -or $Case.classification -ne "verified" -or $Case.canaryDenominatorEligible -ne $true `
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
        if (($Case.classification -eq "infrastructure_error") -ne ($Case.canaryDenominatorEligible -eq $false)) {
          $Violations += "case '$($Case.id)' has inconsistent infrastructure eligibility"
        }
      }
    }

    $BindingFailures = @($Cases | Where-Object { $_.evaluator.bindingPassed -ne $true }).Count
    $IntegrityFailures = @($Cases | Where-Object { $_.evaluator.integrityPassed -ne $true }).Count
    $GraderFailures = @($Cases | Where-Object { $_.evaluator.graderPassed -ne $true }).Count
    if ($Aggregate.hostCaseEvaluation.bindingFailures -ne $BindingFailures `
      -or $Aggregate.hostCaseEvaluation.integrityFailures -ne $IntegrityFailures `
      -or $Aggregate.hostCaseEvaluation.graderFailures -ne $GraderFailures) {
      $Violations += "gauntlet host-case evaluation summary does not match its case evidence"
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
