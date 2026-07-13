param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $Root
try {
    if (-not $SkipBuild) {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "Vanguard build failed." }
    }
    & npm link
    if ($LASTEXITCODE -ne 0) { throw "npm link failed." }
    $Command = Get-Command vanguard -ErrorAction Stop
    Write-Host "Vanguard command installed: $($Command.Source)" -ForegroundColor Green
    Write-Host "Run 'vanguard' from any project directory to open the terminal UI."
}
finally {
    Pop-Location
}
