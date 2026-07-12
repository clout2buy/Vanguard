param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$CredentialVariable = switch ($Provider) {
  "openai" { "OPENAI_API_KEY" }
  "anthropic" { "ANTHROPIC_API_KEY" }
  "deepseek" { "DEEPSEEK_API_KEY" }
}
$SecretsRoot = Join-Path $Root ".vanguard\secrets"
$SecretFile = Join-Path $SecretsRoot "$CredentialVariable.dpapi"
$Secret = Read-Host "Paste $CredentialVariable (input is hidden)" -AsSecureString
if ($Secret.Length -eq 0) { throw "No credential was entered." }

New-Item -ItemType Directory -Force -Path $SecretsRoot | Out-Null
$Secret | ConvertFrom-SecureString | Set-Content -LiteralPath $SecretFile -Encoding UTF8
Write-Host "Stored an encrypted project credential at $SecretFile" -ForegroundColor Green
Write-Host "It is protected for the current Windows account and excluded from git." -ForegroundColor Green
