param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace,

  [Parameter(Mandatory = $true)]
  [string]$Task,

  [ValidateSet("openai", "anthropic", "deepseek")]
  [string]$Provider = "deepseek",

  [string]$Model = "",

  [int]$MaxSteps = 240,
  [long]$MaxDurationMs = 7200000,
  [long]$CommandTimeoutMs = 1800000,
  [string[]]$Protect = @(),
  [string[]]$EditableRoot = @(),
  [string[]]$AllowCommand = @()
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "credential.ps1")
Import-VanguardCredential -Provider $Provider -Root $Root

if ([string]::IsNullOrWhiteSpace($Model)) {
  $Model = switch ($Provider) {
    "deepseek" { "deepseek-v4-pro" }
    default { throw "-Model is required when Provider is $Provider." }
  }
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
  throw "Workspace does not exist or is not a directory: $Workspace"
}

$Arguments = @(
  "dist/src/cli.js", "run",
  "--workspace", (Resolve-Path -LiteralPath $Workspace).Path,
  "--task", $Task,
  "--provider", $Provider,
  "--model", $Model,
  "--max-steps", [string]$MaxSteps,
  "--max-duration-ms", [string]$MaxDurationMs,
  "--command-timeout-ms", [string]$CommandTimeoutMs
)
foreach ($Path in $Protect) { $Arguments += @("--protect", $Path) }
foreach ($Path in $EditableRoot) { $Arguments += @("--editable-root", $Path) }
foreach ($Command in $AllowCommand) { $Arguments += @("--allow-command", $Command) }

Push-Location $Root
try {
  if (Test-Path -LiteralPath (Join-Path $Root "src") -PathType Container) {
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  node @Arguments
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
