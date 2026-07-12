param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider,

  [Parameter(Mandatory = $true)]
  [string]$Model
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$CredentialVariable = switch ($Provider) {
  "openai" { "OPENAI_API_KEY" }
  "anthropic" { "ANTHROPIC_API_KEY" }
  "deepseek" { "DEEPSEEK_API_KEY" }
}
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($CredentialVariable, "Process"))) {
  throw "Missing $CredentialVariable. Set `$env:$CredentialVariable in this PowerShell session before running the gauntlet. No benchmark cases were started."
}
$Root = Split-Path -Parent $PSScriptRoot
$CasesRoot = Join-Path $Root "gauntlet\cases"
$ResultsRoot = Join-Path $Root "gauntlet\results"
New-Item -ItemType Directory -Force -Path $ResultsRoot | Out-Null

Push-Location $Root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $Results = @()
  foreach ($CaseFile in Get-ChildItem -LiteralPath $CasesRoot -Filter case.json -Recurse | Sort-Object FullName) {
    $CaseRoot = Split-Path -Parent $CaseFile.FullName
    $Case = Get-Content -Raw -LiteralPath $CaseFile.FullName | ConvertFrom-Json
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
      "--restrict-process", "true",
      "--verifier-evidence", "summary",
      "--max-steps", [string]$Case.maxSteps
    )
    foreach ($Protected in $Case.protected) { $Arguments += @("--protect", [string]$Protected) }
    foreach ($EditableRoot in $Case.editableRoots) { $Arguments += @("--editable-root", [string]$EditableRoot) }

    Write-Host "Running $($Case.id) [$($Case.track)]..." -ForegroundColor Cyan
    $Raw = (& node @Arguments | Out-String)
    $ExitCode = $LASTEXITCODE
    try {
      $Scorecard = $Raw | ConvertFrom-Json
      $Results += [pscustomobject]@{
        id = $Case.id
        track = $Case.track
        score = $Scorecard.grade.score
        verified = $Scorecard.grade.verified
        steps = $Scorecard.grade.steps
        durationMs = $Scorecard.durationMs
        toolFailures = $Scorecard.trajectory.toolFailures
        verificationFailures = $Scorecard.trajectory.verificationFailures
        completionClaims = $Scorecard.trajectory.completionClaims
        policyBlocks = $Scorecard.trajectory.policyBlocks
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
        track = $Case.track
        score = 0
        verified = $false
        steps = 0
        durationMs = 0
        toolFailures = 0
        verificationFailures = 0
        completionClaims = 0
        policyBlocks = 0
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
  $Passed = @($Results | Where-Object verified).Count
  $Aggregate = [pscustomobject]@{
    version = 1
    provider = $Provider
    model = $Model
    passed = $Passed
    total = $Total
    score = if ($Total -eq 0) { 0 } else { $Passed / $Total }
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    trajectory = [pscustomobject]@{
      totalSteps = [int](($Results | Measure-Object -Property steps -Sum).Sum)
      toolFailures = [int](($Results | Measure-Object -Property toolFailures -Sum).Sum)
      verificationFailures = [int](($Results | Measure-Object -Property verificationFailures -Sum).Sum)
      completionClaims = [int](($Results | Measure-Object -Property completionClaims -Sum).Sum)
      policyBlocks = [int](($Results | Measure-Object -Property policyBlocks -Sum).Sum)
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
  $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Output = Join-Path $ResultsRoot "gauntlet-$Stamp.json"
  $Aggregate | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Output -Encoding UTF8
  $Aggregate | ConvertTo-Json -Depth 10
  Write-Host "Aggregate scorecard: $Output" -ForegroundColor Green
  if ($Passed -ne $Total) { exit 1 }
}
finally {
  Pop-Location
}
