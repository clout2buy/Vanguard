function Import-VanguardCredential {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("openai", "anthropic", "deepseek")]
    [string]$Provider,

    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  $CredentialVariable = switch ($Provider) {
    "openai" { "OPENAI_API_KEY" }
    "anthropic" { "ANTHROPIC_API_KEY" }
    "deepseek" { "DEEPSEEK_API_KEY" }
  }
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($CredentialVariable, "Process"))) {
    $PersistentCredential = [Environment]::GetEnvironmentVariable($CredentialVariable, "User")
    if (-not [string]::IsNullOrWhiteSpace($PersistentCredential)) {
      [Environment]::SetEnvironmentVariable($CredentialVariable, $PersistentCredential, "Process")
      $PersistentCredential = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($CredentialVariable, "Process"))) {
    $SecretFile = Join-Path $Root ".vanguard\secrets\$CredentialVariable.dpapi"
    if (Test-Path -LiteralPath $SecretFile) {
      $SecureCredential = (Get-Content -Raw -LiteralPath $SecretFile).Trim() | ConvertTo-SecureString
      $CredentialPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCredential)
      try {
        $PlainCredential = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CredentialPointer)
        [Environment]::SetEnvironmentVariable($CredentialVariable, $PlainCredential, "Process")
      }
      finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CredentialPointer)
        $PlainCredential = $null
        $SecureCredential = $null
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($CredentialVariable, "Process"))) {
    throw "Missing $CredentialVariable. Set it in the current process, Windows user environment, or Vanguard's DPAPI secret store."
  }
}
