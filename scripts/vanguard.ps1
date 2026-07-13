param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$VanguardArguments
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Cli = Join-Path $Root "dist\src\cli.js"
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) {
    throw "Vanguard is not built. Run 'npm run build' in $Root first."
}
$Node = Get-Command node -ErrorAction Stop
& $Node.Source $Cli @VanguardArguments
exit $LASTEXITCODE
