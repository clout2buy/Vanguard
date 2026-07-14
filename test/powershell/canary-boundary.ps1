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
  $OptionalFixture = [pscustomobject]@{
    present = 42
    explicitNull = $null
  }
  Assert-CanaryTest `
    ((Get-CanaryOptionalProperty -InputObject $OptionalFixture -Name "missing" -Default 600000) -eq 600000) `
    "A missing optional property did not receive its default under strict mode."
  Assert-CanaryTest `
    ((Get-CanaryOptionalProperty -InputObject $OptionalFixture -Name "present" -Default 1) -eq 42) `
    "A present optional property was replaced by its default."
  Assert-CanaryTest `
    ($null -eq (Get-CanaryOptionalProperty -InputObject $OptionalFixture -Name "explicitNull" -Default 1)) `
    "An explicit null optional property was not preserved."
  $UnicodeFixturePath = Join-Path $TemporaryRoot "unicode-task.md"
  $UnicodeFixture = "Résumé → café … preserve `"registered`" and `"started`"`r`nExact trailing line`n"
  [IO.File]::WriteAllText($UnicodeFixturePath, $UnicodeFixture, [Text.UTF8Encoding]::new($false))
  Assert-CanaryTest `
    ((Read-CanaryUtf8Text -Path $UnicodeFixturePath) -ceq $UnicodeFixture) `
    "The strict UTF-8 reader changed Unicode text or line endings."
  $UnicodeAggregatePath = Join-Path $TemporaryRoot "unicode-aggregate.json"
  $UnicodeModel = ([string][char]0x6A21) + ([string][char]0x578B)
  [IO.File]::WriteAllText(
    $UnicodeAggregatePath,
    ('{"model":"' + $UnicodeModel + '"}'),
    [Text.UTF8Encoding]::new($false)
  )
  $UnicodeAggregate = Read-CanaryUtf8Text -Path $UnicodeAggregatePath | ConvertFrom-Json
  Assert-CanaryTest ($UnicodeAggregate.model -ceq $UnicodeModel) `
    "The aggregate JSON path did not preserve UTF-8 without a BOM under Windows PowerShell 5.1."
  $ProbeScript = Join-Path $TemporaryRoot "utf8 stdio probe.mjs"
  [IO.File]::WriteAllText(
    $ProbeScript,
    'process.stdout.write(process.argv[2]); process.stderr.write(process.argv[2]);',
    [Text.UTF8Encoding]::new($false)
  )
  $PreviousNodeOptions = [Environment]::GetEnvironmentVariable("NODE_OPTIONS", "Process")
  $PreviousEventStream = [Environment]::GetEnvironmentVariable("VANGUARD_EVENT_STREAM", "Process")
  try {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", "--require definitely-missing-canary-preload", "Process")
    [Environment]::SetEnvironmentVariable("VANGUARD_EVENT_STREAM", "1", "Process")
    $ProbeEnvironment = Get-CanaryProcessEnvironment
  }
  finally {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $PreviousNodeOptions, "Process")
    [Environment]::SetEnvironmentVariable("VANGUARD_EVENT_STREAM", $PreviousEventStream, "Process")
  }
  Assert-CanaryTest (-not $ProbeEnvironment.ContainsKey("NODE_OPTIONS")) "NODE_OPTIONS escaped canary sanitization."
  Assert-CanaryTest (-not $ProbeEnvironment.ContainsKey("VANGUARD_EVENT_STREAM")) "An inherited Vanguard switch escaped canary sanitization."
  Assert-CanaryTest ($ProbeEnvironment["VANGUARD_DELEGATION_DEPTH"] -eq "0") "Delegation depth is not pinned."
  $NodeNpmProbe = Get-CanaryNodeAndNpmEntrypoint
  $NpmVersionProbe = Invoke-CanaryUtf8Process `
    -FilePath $NodeNpmProbe.node `
    -ArgumentList @($NodeNpmProbe.npmCli, "--version") `
    -Environment $ProbeEnvironment `
    -WorkingDirectory $TemporaryRoot `
    -TimeoutMs 30000
  Assert-CanaryTest ($NpmVersionProbe.exitCode -eq 0) `
    "A hostile inherited NODE_OPTIONS value reached the sanitized npm process."
  $ExactNativeArgument = "Résumé → café … preserve `"quoted`"`r`nExact trailing line`n"
  $Probe = Invoke-CanaryUtf8Process `
    -FilePath (Get-Command node -ErrorAction Stop).Source `
    -ArgumentList @($ProbeScript, $ExactNativeArgument) `
    -Environment $ProbeEnvironment `
    -WorkingDirectory $TemporaryRoot `
    -TimeoutMs 10000
  Assert-CanaryTest ($Probe.exitCode -eq 0) "The byte-safe native process probe failed."
  Assert-CanaryTest (-not $Probe.timedOut) "A completed byte-safe native process was marked timed out."
  Assert-CanaryTest ($Probe.stdout -ceq $ExactNativeArgument) "UTF-8 stdout or native argv changed under powershell.exe."
  Assert-CanaryTest ($Probe.stderr -ceq $ExactNativeArgument) "UTF-8 stderr changed under powershell.exe."
  $TimeoutProbeScript = Join-Path $TemporaryRoot "timeout-tree-probe.cjs"
  [IO.File]::WriteAllText(
    $TimeoutProbeScript,
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000);',
    [Text.UTF8Encoding]::new($false)
  )
  $TimeoutWatch = [Diagnostics.Stopwatch]::StartNew()
  $TimeoutProbe = Invoke-CanaryUtf8Process `
    -FilePath (Get-Command node -ErrorAction Stop).Source `
    -ArgumentList @($TimeoutProbeScript) `
    -Environment $ProbeEnvironment `
    -WorkingDirectory $TemporaryRoot `
    -TimeoutMs 500
  $TimeoutWatch.Stop()
  Assert-CanaryTest $TimeoutProbe.timedOut "The bounded process probe did not report its timeout."
  Assert-CanaryTest ($TimeoutProbe.exitCode -eq 124) "A timed-out process did not receive the stable harness exit code."
  Assert-CanaryTest ($TimeoutWatch.ElapsedMilliseconds -lt 15000) "Timed-out process-tree termination exceeded its fixed grace period."
  $DescendantPid = 0
  Assert-CanaryTest ([int]::TryParse($TimeoutProbe.stdout, [ref]$DescendantPid)) "The timeout probe did not report its descendant PID."
  Start-Sleep -Milliseconds 100
  Assert-CanaryTest ($null -eq (Get-Process -Id $DescendantPid -ErrorAction SilentlyContinue)) `
    "A descendant survived timed-out Windows process-tree termination."
  $PrivateRunnerSource = Get-Content -Raw -LiteralPath (Join-Path $Root "scripts\run-private-gauntlet.ps1")
  Assert-CanaryTest `
    ($PrivateRunnerSource -notmatch '\$(?:Case|CandidateCase)\.(?:version|maxDurationMs|maxContextBytes|rawProcess)\b') `
    "The private gauntlet runner directly reads an optional case property under strict mode."
  Assert-CanaryTest `
    ($PrivateRunnerSource -notmatch 'EvaluationRequest|EvaluationJson|--request-base64') `
    "The private gauntlet runner still serializes the sealed task through PowerShell."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match '--case-file') `
    "The private gauntlet runner does not use the evaluator's pinned case-file transport."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match '--preflight-case-file' `
      -and $PrivateRunnerSource -match '\$TaskFile\s*=\s*\[string\]\$CasePaths\.taskFile' `
      -and $PrivateRunnerSource -match 'Read-CanaryUtf8Text\s+-Path\s+\$TaskFile') `
    "The private gauntlet runner does not preflight and validate the canonical sealed task file."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match '"--task-file",\s*\$TaskFile' `
      -and $PrivateRunnerSource -notmatch '"--task",\s*\$Task\b') `
    "The private gauntlet runner still sends task text through native PowerShell argv."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match '"--max-context-bytes"' `
      -and $PrivateRunnerSource -match '"--command-timeout-ms",\s*"1800000"' `
      -and $PrivateRunnerSource -match '"--max-verification-attempts",\s*"3"' `
      -and $PrivateRunnerSource -match '"--expose-raw-process"' `
      -and $PrivateRunnerSource -match '"--disable-extensions",\s*"true"') `
    "The private gauntlet runner does not pass every sealed effective runtime default explicitly."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match 'Invoke-CanaryUtf8Process' -and $PrivateRunnerSource -notmatch '\(&\s*node\b') `
    "The private gauntlet runner still captures Node output through PowerShell's active text code page."
  Assert-CanaryTest `
    ($PrivateRunnerSource -match '-TimeoutMs\s+30000' `
      -and $PrivateRunnerSource -match '-TimeoutMs\s+\$EngineTimeoutMs' `
      -and $PrivateRunnerSource -match '-TimeoutMs\s+660000' `
      -and $PrivateRunnerSource -match '--engine-timed-out') `
    "Preflight, candidate, or evaluator execution is missing its sealed timeout contract."
  $CanaryRunnerSource = Get-Content -Raw -LiteralPath (Join-Path $Root "scripts\run-canary.ps1")
  $BuildPosition = $CanaryRunnerSource.IndexOf('$BuildProcess = Invoke-CanaryUtf8Process')
  $CredentialPosition = $CanaryRunnerSource.IndexOf('Import-VanguardCredential -Provider $Provider -Root $Root')
  Assert-CanaryTest `
    ($BuildPosition -ge 0 -and $CredentialPosition -gt $BuildPosition `
      -and $CanaryRunnerSource -match '\$BuildEnvironment\s*=\s*Get-CanaryProcessEnvironment' `
      -and $CanaryRunnerSource -match 'npm_config_userconfig') `
    "The pinned install/build is not sanitized before provider credential import."
  Assert-CanaryTest `
    ($CanaryRunnerSource -match 'git\s+-C\s+\$Worktree\s+clean\s+-ffdx\s+--\s+gauntlet/cases' `
      -and $CanaryRunnerSource -match 'CaseManifestBeforeBuild' `
      -and $CanaryRunnerSource -match 'CaseManifestAfterBuild' `
      -and $CanaryRunnerSource -match 'CaseManifestAfterRun' `
      -and $CanaryRunnerSource -match 'caseBinding' `
      -and $CanaryRunnerSource -match 'status\s+--porcelain\s+--untracked-files=all') `
    "The pinned canary does not bind the complete disposable case tree at all three lifecycle points."
  $Attributes = Get-Content -Raw -LiteralPath (Join-Path $Root ".gitattributes")
  Assert-CanaryTest `
    ($Attributes -notmatch '(?m)^gauntlet/cases/\*\*\s+text\b' `
      -and $Attributes -match '(?m)^gauntlet/cases/\*\*/\*\.json\s+text\s+eol=lf\s*$' `
      -and $Attributes -match '(?m)^gauntlet/cases/\*\*/\*\.md\s+text\s+eol=lf\s*$' `
      -and $Attributes -match '(?m)^gauntlet/cases/\*\*/\*\.png\s+-text\s*$' `
      -and $Attributes -match '(?m)^gauntlet/cases/\*\*/\*\.jar\s+-text\s*$') `
    "Gauntlet EOL rules are not narrow or do not protect binary fixtures."

  $Pinned = Resolve-CanaryCommit -RepositoryRoot $Root -Commit "HEAD~1"
  $Active = Resolve-CanaryCommit -RepositoryRoot $Root -Commit "HEAD"
  Assert-CanaryTest ($Pinned -ne $Active) "The pinning fixture requires HEAD~1 to differ from HEAD."

  $Created = $true
  $CreatedPath = New-IsolatedCanaryWorktree -RepositoryRoot $Root -Commit $Pinned -Destination $Worktree
  $Observed = Resolve-CanaryCommit -RepositoryRoot $CreatedPath -Commit HEAD
  Assert-CanaryTest ($Observed -eq $Pinned) "The detached worktree did not stay on the requested historical commit."
  Assert-CanaryTest ($Observed -ne $Active) "The detached worktree followed the active branch instead of the pin."
  $CleanCaseState = Get-CanaryGitPathState -RepositoryRoot $CreatedPath -RelativePaths @("gauntlet/cases")
  $CleanCaseStateJson = $CleanCaseState | ConvertTo-Json -Compress
  Assert-CanaryTest `
    (@($CleanCaseState.changes).Count -eq 0 -and $CleanCaseStateJson -match '"changes":\[\]') `
    "A clean scoped git state did not serialize its closed changes array as []."

  $CasesPath = Join-Path $CreatedPath "gauntlet\cases"
  $CasesBefore = Get-CanaryFileManifest -Root $CasesPath
  $IgnoredInjection = Join-Path $CasesPath ".boundary-fixture\node_modules\injected.bin"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $IgnoredInjection) | Out-Null
  [IO.File]::WriteAllBytes($IgnoredInjection, [byte[]](0, 1, 2, 255))
  $CasesAfter = Get-CanaryFileManifest -Root $CasesPath
  $CaseGitWithIgnored = Get-CanaryGitPathState -RepositoryRoot $CreatedPath -RelativePaths @("gauntlet/cases")
  Assert-CanaryTest ($CasesBefore.aggregateSha256 -ne $CasesAfter.aggregateSha256) `
    "A binary ignored/untracked case-tree addition did not alter the byte manifest."
  Assert-CanaryTest (@($CaseGitWithIgnored.changes).Count -gt 0) `
    "A binary ignored/untracked case-tree addition escaped scoped git state inspection."
  & git -C $CreatedPath clean -ffdx -- gauntlet/cases 2>&1 | Out-Null
  Assert-CanaryTest ($LASTEXITCODE -eq 0) "The disposable case-tree cleanup fixture failed."
  $CasesRestored = Get-CanaryFileManifest -Root $CasesPath
  Assert-CanaryTest ($CasesBefore.aggregateSha256 -eq $CasesRestored.aggregateSha256) `
    "Cleaning the disposable case tree did not restore the pinned byte manifest."

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

  $HiddenDirectory = Join-Path $Dist "hidden-modules"
  New-Item -ItemType Directory -Force -Path $HiddenDirectory | Out-Null
  $HiddenFile = Join-Path $HiddenDirectory "loaded.js"
  [IO.File]::WriteAllText($HiddenFile, "hidden payload", [Text.UTF8Encoding]::new($false))
  [IO.File]::SetAttributes(
    $HiddenDirectory,
    ([IO.File]::GetAttributes($HiddenDirectory) -bor [IO.FileAttributes]::Hidden)
  )
  [IO.File]::SetAttributes(
    $HiddenFile,
    ([IO.File]::GetAttributes($HiddenFile) -bor [IO.FileAttributes]::Hidden)
  )
  $WithHiddenArtifact = Get-CanaryFileManifest -Root $Dist
  Assert-CanaryTest `
    ($After.aggregateSha256 -ne $WithHiddenArtifact.aggregateSha256 `
      -and @($WithHiddenArtifact.files | Where-Object { $_.path -eq "hidden-modules/loaded.js" }).Count -eq 1) `
    "A Windows Hidden file or directory escaped the artifact manifest."

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
    canaryDenominatorEligible = $true
    exitCode = 0
    evaluator = [pscustomobject]@{
      bindingPassed = $true
      integrityPassed = $true
      graderPassed = $true
      violations = @()
    }
  }
  $ValidAggregate = [pscustomobject]@{
    version = 9
    evidenceBoundary = New-CanaryEvidenceBoundary -Purpose "regression-diagnostic"
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
    hostCaseEvaluation = [pscustomobject]@{
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

  $MissingBoundaryAggregate = $ValidAggregate | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $MissingBoundaryAggregate.PSObject.Properties.Remove("evidenceBoundary")
  $MissingBoundaryViolations = @(Get-CanaryAggregateViolations `
    -Aggregate $MissingBoundaryAggregate -InfrastructureProbe $false `
    -PinnedCommit $Pinned -ArtifactHash "artifact" `
    -Provider "deepseek" -Model "fixture" -EvaluationExitCode 0)
  Assert-CanaryTest (($MissingBoundaryViolations -join "`n") -match "evidence boundary") `
    "A canary aggregate without an evidence boundary was accepted."

  $ClaimableAggregate = $ValidAggregate | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $ClaimableAggregate.evidenceBoundary.phase13CertificationEligible = $true
  $ClaimableViolations = @(Get-CanaryAggregateViolations `
    -Aggregate $ClaimableAggregate -InfrastructureProbe $false `
    -PinnedCommit $Pinned -ArtifactHash "artifact" `
    -Provider "deepseek" -Model "fixture" -EvaluationExitCode 0)
  Assert-CanaryTest (($ClaimableViolations -join "`n") -match "cannot be competitive or Phase-13") `
    "A visible canary marked as Phase-13-eligible was accepted."

  $OpenBoundaryAggregate = $ValidAggregate | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $OpenBoundaryAggregate.evidenceBoundary | Add-Member `
    -NotePropertyName certificationOutcome `
    -NotePropertyValue "overall-superiority"
  $OpenBoundaryViolations = @(Get-CanaryAggregateViolations `
    -Aggregate $OpenBoundaryAggregate -InfrastructureProbe $false `
    -PinnedCommit $Pinned -ArtifactHash "artifact" `
    -Provider "deepseek" -Model "fixture" -EvaluationExitCode 0)
  Assert-CanaryTest (($OpenBoundaryViolations -join "`n") -match "closed schema") `
    "An identity-bearing field escaped the closed canary evidence boundary."

  $InfrastructureCase = [pscustomobject]@{
    id = "infrastructure-case"
    verified = $false
    score = 0
    classification = "infrastructure_error"
    canaryDenominatorEligible = $false
    exitCode = 1
    evaluator = [pscustomobject]@{
      bindingPassed = $true
      integrityPassed = $true
      graderPassed = $false
      violations = @("provider unavailable")
    }
  }
  $InflatedAggregate = [pscustomobject]@{
    version = 9
    evidenceBoundary = New-CanaryEvidenceBoundary -Purpose "regression-diagnostic"
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
    hostCaseEvaluation = [pscustomobject]@{
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
