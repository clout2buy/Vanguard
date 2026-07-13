# Portability and packaging

Vanguard is a Node.js ESM package. The supported runtime range is
`>=20.19 <25`, tested as the Node 20.19, 22, and 24 lines on Windows, macOS,
and Linux. The CI definition is `.github/workflows/portability.yml`; it runs
the full suite and a clean packed-artifact install on every matrix cell with
no provider credentials.

## Launch behavior

The npm package exposes the `vanguard` bin, whose shebang launches the compiled
CLI. Two explicit launchers are also included:

- `scripts/vanguard.ps1` for Windows PowerShell/PowerShell;
- `scripts/vanguard` for POSIX shells. It uses `exec`, so terminal signals are
  delivered to the Node process rather than trapped by a shell wrapper.

Both resolve the package root from their own location, quote paths, forward
arguments exactly, and work when the current directory contains spaces or
Unicode. The PowerShell launcher returns the Node process exit code. The
stdio engine uses LF-delimited UTF-8 JSON while accepting CRLF and arbitrary
byte chunk boundaries.

## Artifact smoke

Run:

```text
npm run test:pack
```

The smoke script creates a temporary destination, runs `npm pack --json`,
asserts the required engine/provider/launcher files are present, installs the
tarball into a clean project whose path contains spaces, imports the public
TypeScript/ESM surface, invokes the packed CLI, and removes all temporary
files. It never publishes and never contacts a model provider.

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
