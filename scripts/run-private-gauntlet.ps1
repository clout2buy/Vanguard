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
$ResultsRoot = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  Join-Path $Root "gauntlet\results"
}
else {
  Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
}
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null

Push-Location $Root
try {
  if (-not $SkipBuild) {
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  $Results = @()
  foreach ($CaseFile in Get-ChildItem -LiteralPath $CasesRoot -Filter case.json -Recurse | Sort-Object FullName) {
    $CaseRoot = Split-Path -Parent $CaseFile.FullName
    $Case = Get-Content -Raw -LiteralPath $CaseFile.FullName | ConvertFrom-Json
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
      "--max-duration-ms", $(if ($null -eq $Case.maxDurationMs) { "600000" } else { [string]$Case.maxDurationMs }),
      "--max-verification-attempts", "3",
      "--max-steps", [string]$Case.maxSteps
    )
    if ($null -ne $Case.maxContextBytes) { $Arguments += @("--max-context-bytes", [string]$Case.maxContextBytes) }
    if ($null -ne $Case.publicCheck) {
      $Arguments += @("--check-command", [string]$Case.publicCheck.command)
      foreach ($CheckArgument in $Case.publicCheck.args) { $Arguments += @("--check-arg", [string]$CheckArgument) }
    }
    if ($null -ne $Case.rawProcess) { $Arguments += @("--expose-raw-process", ([string]$Case.rawProcess).ToLowerInvariant()) }
    foreach ($Protected in $Case.protected) { $Arguments += @("--protect", [string]$Protected) }
    foreach ($EditableRoot in $Case.editableRoots) { $Arguments += @("--editable-root", [string]$EditableRoot) }

    Write-Host "Running $($Case.id) [$($Case.track)]..." -ForegroundColor Cyan
    $Raw = (& node @Arguments | Out-String)
    $ExitCode = $LASTEXITCODE
    try {
      $Scorecard = $Raw | ConvertFrom-Json
      $Results += [pscustomobject]@{
        id = $Case.id
        caseVersion = if ($null -eq $Case.version) { 1 } else { [int]$Case.version }
        track = $Case.track
        score = $Scorecard.grade.score
        verified = $Scorecard.grade.verified
        classification = $Scorecard.grade.classification
        capabilityEligible = $Scorecard.grade.classification -ne "infrastructure_error"
        steps = $Scorecard.grade.steps
        durationMs = $Scorecard.durationMs
        toolFailures = $Scorecard.trajectory.toolFailures
        localTestFailures = $Scorecard.trajectory.localTestFailures
        testHarnessFailures = $Scorecard.trajectory.testHarnessFailures
        toolFrictionFailures = $Scorecard.trajectory.toolFrictionFailures
        verificationFailures = $Scorecard.trajectory.verificationFailures
        completionClaims = $Scorecard.trajectory.completionClaims
        policyBlocks = $Scorecard.trajectory.policyBlocks
        contextCompactions = $Scorecard.trajectory.contextCompactions
        executionQuality = $Scorecard.grade.executionQuality.score
        changedFiles = $Scorecard.patch.changedFiles.Count
        filesAdded = $Scorecard.patch.filesAdded
        filesDeleted = $Scorecard.patch.filesDeleted
        filesModified = $Scorecard.patch.filesModified
        beforeLines = $Scorecard.patch.beforeLines
        afterLines = $Scorecard.patch.afterLines
        session = $Scorecard.workspaceRoot
        scorecard = $Scorecard.scorecardFile
        exitCode = $ExitCode
      }
    }
    catch {
      $Results += [pscustomobject]@{
        id = $Case.id
        caseVersion = if ($null -eq $Case.version) { 1 } else { [int]$Case.version }
        track = $Case.track
        score = 0
        verified = $false
        classification = "infrastructure_error"
        capabilityEligible = $false
        steps = 0
        durationMs = 0
        toolFailures = 0
        localTestFailures = 0
        testHarnessFailures = 0
        toolFrictionFailures = 0
        verificationFailures = 0
        completionClaims = 0
        policyBlocks = 0
        contextCompactions = 0
        executionQuality = 0
        changedFiles = 0
        filesAdded = 0
        filesDeleted = 0
        filesModified = 0
        beforeLines = 0
        afterLines = 0
        session = $null
        scorecard = $null
        exitCode = $ExitCode
        parseError = $_.Exception.Message
        raw = $Raw
      }
    }
  }

  $Total = $Results.Count
  if ($Total -eq 0) {
    throw "No gauntlet cases matched -CaseId: $($CaseId -join ', ')."
  }
  $EvaluatedResults = @($Results | Where-Object capabilityEligible)
  $Evaluated = $EvaluatedResults.Count
  $InfrastructureErrors = $Total - $Evaluated
  $Passed = @($EvaluatedResults | Where-Object verified).Count
  $Aggregate = [pscustomobject]@{
    version = 7
    provider = $Provider
    model = $Model
    passed = $Passed
    total = $Total
    evaluated = $Evaluated
    infrastructureErrors = $InfrastructureErrors
    score = if ($Evaluated -eq 0) { $null } else { $Passed / $Evaluated }
    executionQuality = if ($Evaluated -eq 0) { $null } else {
      [math]::Round((($EvaluatedResults | Measure-Object -Property executionQuality -Average).Average), 3)
    }
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
  if ($Passed -ne $Evaluated) { exit 1 }
}
finally {
  Pop-Location
}
