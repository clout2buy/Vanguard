# Portability and packaging

Vanguard is a Node.js ESM package. The declared runtime range is
`>=20.19 <25`. The target matrix is Node 20.19, 22, and 24 on Windows, macOS,
and Linux. The CI definition is `.github/workflows/portability.yml`; it is
configured to run the full suite and a clean packed-artifact install on every
matrix cell with no provider credentials. At this checkpoint the workflow is
authored but has not produced a recorded nine-cell run, so only the local
Windows checks and clean-package smoke recorded in `docs/MASTER_REPORT.md`
count as executed evidence.

The full-suite command does not rely on shell glob expansion. After TypeScript
compilation, `scripts/run-tests.mjs` recursively enumerates and sorts every
`dist/test/**/*.test.js` file before starting Node's test runner. This is
necessary because Windows shells do not expand the glob and supported Node
releases do not handle a directory/glob argument identically.

## Launch behavior

The npm package exposes the `vanguard` bin, whose shebang launches the compiled
CLI. Two explicit launchers are also included:

- `scripts/vanguard.ps1` for Windows PowerShell/PowerShell;
- `scripts/vanguard` for POSIX shells, invoked as `sh scripts/vanguard` when a
  tarball was produced on Windows (portable tar creation does not preserve an
  executable bit). It uses `exec`, so terminal signals are delivered to the
  Node process rather than trapped by a shell wrapper. Normal installs should
  prefer the executable npm `vanguard` bin.

Both resolve the package root from their own location, quote paths, forward
arguments exactly, and work when the current directory contains spaces or
Unicode. The PowerShell launcher returns the Node process exit code. The
stdio engine uses LF-delimited UTF-8 JSON while accepting CRLF and arbitrary
byte chunk boundaries.

The Windows launcher deliberately selects a real `node.exe`, not a same-named
PowerShell/npm shim. npm and npx execution inside the engine resolves their
JavaScript entry points without a command shell, preferring `npm_execpath` and
then standard Node/prefix/PATH layouts. Restricted Node children use
`--experimental-permission` on Node 20 and the stable `--permission` spelling
on Node 22/24; both disable-flag spellings are blocked from model arguments.

## Artifact smoke

Run:

```text
npm run test:pack
```

The smoke script creates a temporary destination, runs `npm pack --json`,
asserts the required engine/provider/launcher files are present, installs the
tarball into a clean project whose path contains spaces, imports the public
TypeScript/ESM surface, strict-compiles a consuming TypeScript project, invokes
the installed npm bin and the platform launcher without changing its packed
permissions (the POSIX script is passed explicitly to `sh`), loads/renders the packed TUI
module, and removes all temporary files. On Windows it also verifies all three
credential helpers using process-local fixture values; values are compared in
memory and are never logged. It never publishes and never contacts a model
provider.

`npm pack` runs `prepack`, so the artifact always contains JavaScript and type
declarations built from the current source. The repository remains marked
`private` during supervised alpha: the tarball is suitable for controlled
distribution and clean installs, but public registry publication is not yet
claimed.

## Signal and stdio guarantees

Portability tests launch the real compiled CLI, negotiate a protocol handshake
using split UTF-8 and CRLF frames, close it through stdin EOF, and terminate a
live server through the host process API. Exit-code versus signal fields vary
by operating system, so the stable contract is prompt process closure and no
orphaned Vanguard child—not a Unix-only signal number.

There is not yet a native single-file executable or OS installer. Node and npm
remain runtime/distribution prerequisites, and CI success is implementation
evidence rather than proof of behavior on every terminal emulator.

## Executed final local Windows matrix (2026-07-14)

This is local compatibility evidence for code checkpoint
`751ed723c766f21993bf502088c1f15529743270`, not the unexecuted nine-cell CI
result. The runtimes were exercised serially:

| Runtime | Executed suite | Installed packed consumer |
|---|---:|---:|
| Node 20.19.0 | non-Gate: 491 passed, 0 failed, 2 Windows skips (493 total) | passed; 511,606-byte tarball |
| Node 22.22.2 | full: 493 passed, 0 failed, 2 Windows skips (495 total) | passed; 511,606-byte tarball |
| Node 24.4.1 | non-Gate: 491 passed, 0 failed, 2 Windows skips (493 total) | passed; 511,606-byte tarball |

The two skips are platform-specific mode-bit assertions that are inapplicable
on Windows. `npm audit --omit=dev` reported zero production vulnerabilities.
The installed-consumer smoke proves import, type consumption, launcher/bin,
and packaged-surface behavior from the artifact; it does not prove interactive
terminal ergonomics or live-provider behavior. macOS/Linux and PowerShell 7
cells remain unexecuted locally and must not be inferred from this table.

### Invalidated predecessor

An earlier Node 20.19.0 / npm 10.9.7 run at `7902a88` completed 375 tests in
64.167 seconds (373 passed, 0 failed, 2 skipped), but it was invalidated before
the rest of the matrix ran. Post-run adversarial review found that the Ares
adapter could infer worker exit from terminal task state and release without
`stopAndWait` while `workerActive` remained true. Commit `499d668` fixed that
containment seam. No Node 22/24, provider, or package result was collected on
the invalid checkpoint, and none of its numbers are used as final evidence.
