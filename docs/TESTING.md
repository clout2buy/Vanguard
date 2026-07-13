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

## Interactive terminal UI

After running `scripts\install-cli.ps1` once, `vanguard` opens the terminal UI from any PowerShell directory. The current directory is locked in automatically and the only setup input is the coding request. Short greetings, help, thanks, and exit requests are handled locally without starting inference, tools, a verifier, or a disposable coding session. DeepSeek V4 Pro, the expert turn budget, credentials, and verification policy are selected silently once real coding work begins. Existing npm, Gradle, pytest, Cargo, Maven, and supported native build contracts are detected automatically. Blank projects use an adaptive verifier that tells the agent—not the user—to establish a deterministic contract before completion.

During a run, the UI shows a compact conversation, active tool calls, tool outcomes, liveness, context compaction, and verifier decisions. Private reasoning, source-file contents, provider credentials, and sealed verifier evidence are never copied into the public UI stream. Press `Ctrl+C` to interrupt. Once the session has been created, an interrupted run prints a durable `vanguard resume --session ...` command.

The `main` agent may launch real bounded child coding sessions during contracted
execution. Their sanitized public events use durable `agent-...` identifiers,
so the UI displays genuine child lanes rather than simulated activity. A child
patch reaches the parent only through an explicit exact-hash transactional
merge; see `docs/DELEGATION.md`.

## Run a long project

The project wrapper is the easiest terminal entry point. It loads the selected API credential from the current process, the Windows user environment, or Vanguard's ignored DPAPI secret store; builds Vanguard; creates a disposable project copy; and starts a two-hour run with up to 240 model turns.

```powershell
cd D:\Vanguard
.\scripts\run-project.ps1 `
  -Workspace "D:\Projects\my-minecraft-mod" `
  -Task "Implement the feature, preserve compatibility, add appropriate tests, and finish only after the complete build passes."
```

DeepSeek `deepseek-v4-pro` is the default. Pass `-Provider openai -Model MODEL_ID` or `-Provider anthropic -Model MODEL_ID` when using API credentials for those providers. First-party ChatGPT/Codex and Claude subscription OAuth tokens are intentionally not copied into Vanguard.

Vanguard automatically detects npm tests, Python pytest projects, Rust Cargo projects, and Gradle-wrapper projects. For Gradle, it invokes the wrapper JAR directly without a command shell and treats `build --no-daemon` as the trusted completion gate. The default per-build timeout is 30 minutes; the overall invocation budget is two hours. During slow inference or builds, terminal heartbeats confirm that the process is still alive.

The final scorecard prints `workspaceRoot`, `journalFile`, and `scorecardFile`. Inspect and test the disposable `workspaceRoot`; Vanguard does not overwrite the original repository in this preview.

Models without native image input can inspect generated BMP and PNG artifacts through Vanguard's `artifact.inspect_image` tool. The tool decodes pixels inside the workspace and returns compact exposure, color, regional detail/occlusion, HUD-contrast, luminance-map, and optional image-comparison evidence. It does not pretend to provide semantic vision; sealed visual graders and, when configured later, a vision-capable reviewer remain necessary for subjective composition and product-quality judgments.

Optional containment parameters include `-Protect`, `-EditableRoot`, and `-AllowCommand`, each accepting an array. For example:

```powershell
.\scripts\run-project.ps1 `
  -Workspace "D:\Projects\my-minecraft-mod" `
  -Task "Implement region claims and verify the full Gradle build." `
  -Protect @("gradle\wrapper\gradle-wrapper.jar") `
  -EditableRoot @("src")
```

## Direct CLI

```powershell
npm run vanguard -- run `
  --workspace D:\path\to\repository `
  --task "Implement the requested change and verify it." `
  --provider openai `
  --model gpt-5.6 `
  --verify-command npm `
  --verify-arg test
```

When verification can be auto-detected, the same fixed command is automatically exposed to the model as `project.check`; the model cannot alter its argument vector. Repeat `--allow-command NAME` for any additional executable the model needs. Commands run without a command shell, but unrestricted subprocesses are not an OS sandbox; use repositories and credentials appropriate for a preview environment.

If an invocation is interrupted, continue the same disposable session without replaying completed tool actions:

```powershell
node dist/src/cli.js resume --session "C:\Users\Clout\AppData\Local\Temp\vanguard-session-XXXXXX"
```
