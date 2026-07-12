param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider,

  [Parameter(Mandatory = $true)]
  [string]$Model
)

$ErrorActionPreference = "Stop"
$CredentialVariable = switch ($Provider) {
  "openai" { "OPENAI_API_KEY" }
  "anthropic" { "ANTHROPIC_API_KEY" }
  "deepseek" { "DEEPSEEK_API_KEY" }
}
if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($CredentialVariable, "Process"))) {
  throw "Missing $CredentialVariable. Set `$env:$CredentialVariable in this PowerShell session before running the preview."
}
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
    --protect "test.mjs" `
    --protect "package.json" `
    --editable-root "src" `
    --max-steps 60

  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
