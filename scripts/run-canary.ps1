param(
  [Parameter(Mandatory = $true)]
  [string]$Phase,

  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider = "deepseek",

  [string]$Model = "deepseek-v4-pro",

  [string[]]$CaseId = @()
)

# Gate Zero Layer 1: runs the visible development-canary suite and stamps the
# aggregate result with the phase label so before/after diffs are trivial.
# See docs/GATE_ZERO.md for the contamination rules.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ResultsRoot = Join-Path $Root "gauntlet\results"
$Before = Get-ChildItem -LiteralPath $ResultsRoot -Filter "gauntlet-*.json" -ErrorAction SilentlyContinue |
  Sort-Object Name | Select-Object -Last 1

& (Join-Path $PSScriptRoot "run-private-gauntlet.ps1") -Provider $Provider -Model $Model -CaseId $CaseId
$GauntletExit = $LASTEXITCODE

$After = Get-ChildItem -LiteralPath $ResultsRoot -Filter "gauntlet-*.json" |
  Sort-Object Name | Select-Object -Last 1
if ($null -eq $After -or ($null -ne $Before -and $After.FullName -eq $Before.FullName)) {
  Write-Error "The gauntlet did not produce a new aggregate result."
  exit 1
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$SafePhase = ($Phase -replace "[^a-zA-Z0-9_-]", "-").ToLowerInvariant()
$CanaryFile = Join-Path $ResultsRoot "canary-$SafePhase-$Stamp.json"
$Aggregate = Get-Content -Raw -LiteralPath $After.FullName | ConvertFrom-Json
$Wrapped = [pscustomobject]@{
  layer = "development-canary"
  phase = $Phase
  provider = $Provider
  model = $Model
  vanguardCommit = (git -C $Root rev-parse HEAD).Trim()
  sourceAggregate = $After.Name
  recordedAt = (Get-Date).ToUniversalTime().ToString("o")
  result = $Aggregate
}
$Wrapped | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $CanaryFile -Encoding utf8
Write-Host "Canary result recorded: $CanaryFile" -ForegroundColor Green
exit $GauntletExit
