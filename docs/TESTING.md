# Testing the Vanguard preview

The preview runs against a disposable copy of the target repository. The source fixture remains unchanged. A successful run prints the isolated workspace path, journal path, scorecard path, verification evidence, step count, and duration.

## Prerequisites

```powershell
cd D:\Vanguard
npm install
```

Set exactly the credential required by the selected provider:

```powershell
$env:OPENAI_API_KEY = "your API key"
# or
$env:ANTHROPIC_API_KEY = "your API key"
# or
$env:DEEPSEEK_API_KEY = "your API key"
```

## One-command preview

```powershell
.\scripts\run-preview.ps1 -Provider openai -Model gpt-5.6
```

or:

```powershell
.\scripts\run-preview.ps1 -Provider anthropic -Model claude-opus-4-8
```

or:

```powershell
.\scripts\run-preview.ps1 -Provider deepseek -Model deepseek-v4-pro
```

Use a model ID available to your account. The fixture begins broken; Vanguard must inspect it, repair it, execute its tests, and pass the independent verifier. A score of `1` means the verifier accepted the final state. It is a smoke test, not evidence that Vanguard is already superior to established coding agents.

## Run against another repository

```powershell
npm run vanguard -- run `
  --workspace D:\path\to\repository `
  --task "Implement the requested change and verify it." `
  --provider openai `
  --model gpt-5.6 `
  --verify-command npm `
  --verify-arg test
```

Repeat `--allow-command NAME` for any additional executable the model needs. Commands run without a command shell, but subprocesses are not yet OS-sandboxed; use repositories and credentials appropriate for a preview environment.
