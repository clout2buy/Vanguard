param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider,

  [Parameter(Mandatory = $true)]
  [string]$Model
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "credential.ps1")
Import-VanguardCredential -Provider $Provider -Root $Root
$Fixture = Join-Path $Root "gauntlet\fixtures\repair-cart"
$Task = Get-Content -Raw -LiteralPath (Join-Path $Fixture "TASK.md")

Push-Location $Root
try {
  if (Test-Path -LiteralPath (Join-Path $Root "src") -PathType Container) {
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  node dist/src/cli.js run `
    --workspace $Fixture `
    --task $Task `
    --provider $Provider `
    --model $Model `
    --protect "test.mjs" `
    --protect "package.json" `
    --editable-root "src" `
    --max-steps 60

  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
