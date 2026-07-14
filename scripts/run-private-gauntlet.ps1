param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider,

  [Parameter(Mandatory = $true)]
  [string]$Model,

  [string[]]$CaseId = @(),

  [string]$CaseIdJsonBase64 = "",

  [string]$EngineRoot = "",

  [string]$OutputPath = "",

  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$HarnessRoot = Split-Path -Parent $PSScriptRoot
$Root = if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
  $HarnessRoot
}
else {
  [IO.Path]::GetFullPath($EngineRoot)
}
if (-not [string]::IsNullOrWhiteSpace($CaseIdJsonBase64)) {
  $DecodedCaseIds = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CaseIdJsonBase64)) | ConvertFrom-Json
  $CaseId = @($DecodedCaseIds | ForEach-Object { [string]$_ })
}
. (Join-Path $PSScriptRoot "credential.ps1")
. (Join-Path $PSScriptRoot "canary-support.ps1")
Import-VanguardCredential -Provider $Provider -Root $HarnessRoot
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$CasesRoot = Join-Path $Root "gauntlet\cases"
$Evaluator = Join-Path $PSScriptRoot "gauntlet-evaluator.mjs"
if (-not (Test-Path -LiteralPath $Evaluator -PathType Leaf)) {
  throw "The independent gauntlet evaluator is missing: $Evaluator"
}
$ResultsRoot = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  Join-Path $Root "gauntlet\results"
}
else {
  Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
}
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null
if (-not [string]::IsNullOrWhiteSpace($OutputPath) -and (Test-Path -LiteralPath ([IO.Path]::GetFullPath($OutputPath)))) {
  throw "Refusing to overwrite an existing aggregate scorecard: $([IO.Path]::GetFullPath($OutputPath))"
}

Push-Location $Root
try {
  if (-not $SkipBuild) {
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  $CaseFiles = @(Get-ChildItem -LiteralPath $CasesRoot -Filter case.json -Recurse | Sort-Object FullName)
  $CaseCatalog = @{}
  foreach ($CaseFile in $CaseFiles) {
    $CandidateCase = Get-Content -Raw -LiteralPath $CaseFile.FullName | ConvertFrom-Json
    $CandidateVersion = Get-CanaryOptionalProperty -InputObject $CandidateCase -Name "version" -Default 1
    $CandidateMaxDurationMs = Get-CanaryOptionalProperty -InputObject $CandidateCase -Name "maxDurationMs" -Default 600000
    $CandidateMaxContextBytes = Get-CanaryOptionalProperty -InputObject $CandidateCase -Name "maxContextBytes"
    $CandidateRawProcess = Get-CanaryOptionalProperty -InputObject $CandidateCase -Name "rawProcess"
    if ([string]$CandidateCase.id -notmatch "^[a-z0-9][a-z0-9_-]*$") {
      throw "Gauntlet case has an invalid id: $($CaseFile.FullName)"
    }
    if ([string]::IsNullOrWhiteSpace([string]$CandidateCase.track) `
      -or [string]::IsNullOrWhiteSpace([string]$CandidateCase.workspace) `
      -or [string]::IsNullOrWhiteSpace([string]$CandidateCase.task) `
      -or [string]::IsNullOrWhiteSpace([string]$CandidateCase.grader) `
      -or $CandidateCase.maxSteps -isnot [int] -or $CandidateCase.maxSteps -lt 1 `
      -or $null -eq $CandidateCase.publicCheck `
      -or [string]::IsNullOrWhiteSpace([string]$CandidateCase.publicCheck.command) `
      -or $CandidateCase.publicCheck.args -isnot [array] `
      -or $CandidateCase.editableRoots -isnot [array] `
      -or $CandidateCase.protected -isnot [array] `
      -or $CandidateVersion -isnot [int] -or $CandidateVersion -lt 1 -or $CandidateVersion -gt 1000000 `
      -or $CandidateMaxDurationMs -isnot [int] -or $CandidateMaxDurationMs -lt 1 -or $CandidateMaxDurationMs -gt 604800000 `
      -or ($null -ne $CandidateMaxContextBytes -and (
        $CandidateMaxContextBytes -isnot [int] -or $CandidateMaxContextBytes -lt 1024 -or $CandidateMaxContextBytes -gt 100000000
      )) `
      -or ($null -ne $CandidateRawProcess -and $CandidateRawProcess -isnot [bool])) {
      throw "Gauntlet case schema is invalid: $($CaseFile.FullName)"
    }
    if ($CaseCatalog.ContainsKey([string]$CandidateCase.id)) {
      throw "Duplicate gauntlet case id '$($CandidateCase.id)'."
    }
    $CaseCatalog[[string]$CandidateCase.id] = [pscustomobject]@{
      file = $CaseFile
      case = $CandidateCase
      options = [pscustomobject]@{
        version = [int]$CandidateVersion
        maxDurationMs = [int]$CandidateMaxDurationMs
        maxContextBytes = $CandidateMaxContextBytes
        rawProcess = $CandidateRawProcess
      }
    }
  }
  if ($CaseId.Count -gt 0) {
    $Requested = @($CaseId | ForEach-Object { [string]$_ })
    if (@($Requested | Select-Object -Unique).Count -ne $Requested.Count) {
      throw "Duplicate -CaseId values are not allowed."
    }
    $Missing = @($Requested | Where-Object { -not $CaseCatalog.ContainsKey($_) })
    if ($Missing.Count -gt 0) {
      throw "Unknown -CaseId value(s): $($Missing -join ', ')."
    }
  }

  $Results = @()
  foreach ($CatalogEntry in $CaseCatalog.Values | Sort-Object { $_.file.FullName }) {
    $CaseFile = $CatalogEntry.file
    $CaseRoot = Split-Path -Parent $CaseFile.FullName
    $Case = $CatalogEntry.case
    $CaseOptions = $CatalogEntry.options
    if ($CaseId.Count -gt 0 -and $Case.id -notin $CaseId) { continue }
    $Workspace = Join-Path $CaseRoot $Case.workspace
    $Task = Get-Content -Raw -LiteralPath (Join-Path $CaseRoot $Case.task)
    $Grader = Join-Path $CaseRoot $Case.grader
    $Arguments = @(
      "dist/src/cli.js", "run",
      "--workspace", $Workspace,
      "--task", $Task,
      "--provider", $Provider,
      "--model", $Model,
      "--verify-command", "node",
      "--verify-arg", $Grader,
      "--verify-arg", ".",
      "--security-profile", "guarded",
      "--restrict-process", "true",
      "--verifier-evidence", "summary",
      "--max-duration-ms", [string]$CaseOptions.maxDurationMs,
      "--max-verification-attempts", "3",
      "--max-steps", [string]$Case.maxSteps
    )
    if ($null -ne $CaseOptions.maxContextBytes) { $Arguments += @("--max-context-bytes", [string]$CaseOptions.maxContextBytes) }
    if ($null -ne $Case.publicCheck) {
      $Arguments += @("--check-command", [string]$Case.publicCheck.command)
      foreach ($CheckArgument in $Case.publicCheck.args) { $Arguments += @("--check-arg", [string]$CheckArgument) }
    }
    if ($null -ne $CaseOptions.rawProcess) { $Arguments += @("--expose-raw-process", ([string]$CaseOptions.rawProcess).ToLowerInvariant()) }
    foreach ($Protected in $Case.protected) { $Arguments += @("--protect", [string]$Protected) }
    foreach ($EditableRoot in $Case.editableRoots) { $Arguments += @("--editable-root", [string]$EditableRoot) }

    Write-Host "Running $($Case.id) [$($Case.track)]..." -ForegroundColor Cyan
    $Raw = (& node @Arguments | Out-String)
    $ExitCode = $LASTEXITCODE
    $EngineOutputFile = Join-Path $ResultsRoot "engine-$($Case.id)-$([guid]::NewGuid().ToString('N')).json"
    [IO.File]::WriteAllText($EngineOutputFile, $Raw, [Text.UTF8Encoding]::new($false))
    # The evaluator derives its sealed request directly from the pinned case
    # file. Do not round-trip task text through Windows PowerShell's
    # ConvertTo-Json: PS 5.1 can exhibit runaway allocation for particular
    # multiline strings, and duplicating case fields weakens request binding.
    $EvaluatorArguments = @(
      $Evaluator,
      "--case-file", $CaseFile.FullName,
      "--candidate-output-file", $EngineOutputFile,
      "--engine-exit-code", [string]$ExitCode,
      "--provider", $Provider,
      "--model", $Model
    )
    $EvaluationRaw = (& node @EvaluatorArguments | Out-String)
    $EvaluatorExit = $LASTEXITCODE
    if ($EvaluatorExit -ne 0) {
      throw "Independent evaluator failed for '$($Case.id)' with exit code $EvaluatorExit. $EvaluationRaw"
    }
    try {
      $Evaluation = $EvaluationRaw | ConvertFrom-Json
      $Results += $Evaluation
    }
    catch {
      throw "Independent evaluator returned malformed JSON for '$($Case.id)': $($_.Exception.Message)"
    }
  }

  $Total = $Results.Count
  if ($Total -eq 0) {
    throw "No gauntlet cases matched -CaseId: $($CaseId -join ', ')."
  }
  $EvaluatedResults = @($Results | Where-Object capabilityEligible)
  $Evaluated = $EvaluatedResults.Count
  $InfrastructureErrors = $Total - $Evaluated
  $Passed = @($Results | Where-Object verified).Count
  $Aggregate = [pscustomobject]@{
    version = 8
    provider = $Provider
    model = $Model
    passed = $Passed
    total = $Total
    evaluated = $Evaluated
    infrastructureErrors = $InfrastructureErrors
    engineErrors = @($Results | Where-Object classification -eq "engine_error").Count
    complete = $InfrastructureErrors -eq 0
    comparable = $InfrastructureErrors -eq 0
    score = $Passed / $Total
    executionQuality = [math]::Round((($Results | Measure-Object -Property executionQuality -Average).Average), 3)
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    trajectory = [pscustomobject]@{
      totalSteps = [int](($Results | Measure-Object -Property steps -Sum).Sum)
      toolFailures = [int](($Results | Measure-Object -Property toolFailures -Sum).Sum)
      localTestFailures = [int](($Results | Measure-Object -Property localTestFailures -Sum).Sum)
      testHarnessFailures = [int](($Results | Measure-Object -Property testHarnessFailures -Sum).Sum)
      toolFrictionFailures = [int](($Results | Measure-Object -Property toolFrictionFailures -Sum).Sum)
      verificationFailures = [int](($Results | Measure-Object -Property verificationFailures -Sum).Sum)
      completionClaims = [int](($Results | Measure-Object -Property completionClaims -Sum).Sum)
      policyBlocks = [int](($Results | Measure-Object -Property policyBlocks -Sum).Sum)
      contextCompactions = [int](($Results | Measure-Object -Property contextCompactions -Sum).Sum)
    }
    patch = [pscustomobject]@{
      changedFiles = [int](($Results | Measure-Object -Property changedFiles -Sum).Sum)
      filesAdded = [int](($Results | Measure-Object -Property filesAdded -Sum).Sum)
      filesDeleted = [int](($Results | Measure-Object -Property filesDeleted -Sum).Sum)
      filesModified = [int](($Results | Measure-Object -Property filesModified -Sum).Sum)
      beforeLines = [int](($Results | Measure-Object -Property beforeLines -Sum).Sum)
      afterLines = [int](($Results | Measure-Object -Property afterLines -Sum).Sum)
    }
    externalEvaluation = [pscustomobject]@{
      bindingFailures = @($Results | Where-Object { -not $_.evaluator.bindingPassed }).Count
      integrityFailures = @($Results | Where-Object { -not $_.evaluator.integrityPassed }).Count
      graderFailures = @($Results | Where-Object { -not $_.evaluator.graderPassed }).Count
    }
    cases = $Results
  }
  $Output = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    Join-Path $ResultsRoot "gauntlet-$Stamp-$([guid]::NewGuid().ToString('N')).json"
  }
  else {
    [IO.Path]::GetFullPath($OutputPath)
  }
  if (Test-Path -LiteralPath $Output) {
    throw "Refusing to overwrite an existing aggregate scorecard: $Output"
  }
  Write-CanaryJson -InputObject $Aggregate -Path $Output -Depth 10
  $Aggregate | ConvertTo-Json -Depth 10
  Write-Host "Aggregate scorecard: $Output" -ForegroundColor Green
  if ($InfrastructureErrors -gt 0) { exit 2 }
  if ($Passed -ne $Total) { exit 1 }
}
finally {
  Pop-Location
}
