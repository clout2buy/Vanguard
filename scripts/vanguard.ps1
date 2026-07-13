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
$Node = @(Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object {
    [IO.Path]::GetExtension($_.Path) -ieq ".exe"
} | Select-Object -First 1)
if ($Node.Count -eq 0) {
    throw "Vanguard requires a Node.js node.exe on PATH."
}
& $Node[0].Path $Cli @VanguardArguments
exit $LASTEXITCODE
