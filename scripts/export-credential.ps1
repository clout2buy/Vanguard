param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("deepseek", "openai", "anthropic")]
    [string]$Provider,

    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "credential.ps1")
Import-VanguardCredential -Provider $Provider -Root $Root

$variable = switch ($Provider) {
    "deepseek" { "DEEPSEEK_API_KEY" }
    "openai" { "OPENAI_API_KEY" }
    "anthropic" { "ANTHROPIC_API_KEY" }
}

$value = [Environment]::GetEnvironmentVariable($variable, "Process")
if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$variable is not available."
}
[Console]::Out.Write($value)
