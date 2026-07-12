param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic")]
  [string]$Provider,

  [Parameter(Mandatory = $true)]
  [string]$Model
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Fixture = Join-Path $Root "gauntlet\fixtures\repair-cart"
$Task = Get-Content -Raw -LiteralPath (Join-Path $Fixture "TASK.md")

Push-Location $Root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  node dist/src/cli.js run `
    --workspace $Fixture `
    --task $Task `
    --provider $Provider `
    --model $Model `
    --max-steps 60

  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
