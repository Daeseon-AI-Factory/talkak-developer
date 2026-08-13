# Talkak Dev

A lightweight, cross-platform workspace for developers running several projects and local agent
sessions.

## First slice

This repository contains the interactive product shell and its first native runtime slice:

- project switching
- multi-pane workspace layouts
- session status and focus controls
- Korean/English UI switching with local preference persistence
- platform-aware shortcuts (`Command` on macOS, `Control` on Windows/WSL)
- an attention path that opens sessions waiting for a developer decision
- a cross-project Attention inbox with revision-checked local resolution previews
- session summary and conversation-preview inspector plus a real, read-only PTY log
- adaptive phone, tablet, and desktop presentations backed by the same session state
- a phone session view with conversation, terminal, summary, and unsent draft review
- optional app/project/session settings whose default is off
- native macOS / native Windows / Windows WSL runtime target model
- a provider-neutral native PTY boundary for spawn, write, read, resize, snapshot, kill, and discard
- an ANSI terminal loaded on demand only after a desktop session starts

The Tauri desktop app can start the operating system's default shell in an explicit absolute working
directory. Executables and arguments remain runtime configuration; no agent is hardcoded as the
product default. Output replay is memory-bounded and process state is currently in-memory only.
After a PTY has fully exited, an explicit restart discards its old replay buffer before reusing the
session ID. A running session cannot be discarded. The Terminal Log inspector follows each runtime
run separately and reads only the backend's memory-bounded replay; it does not persist output.
Persistence, transcript adapters, session recovery, remote access, voice recognition, and message
sending are not claimed yet. The seeded projects, summaries, attention requests, and conversation
logs remain visibly preview data.

## Run

```sh
pnpm install
pnpm dev
```

The browser run verifies the responsive UI only. Native PTY controls are deliberately unavailable
outside Tauri.

Desktop development:

```sh
pnpm tauri dev
```

In a terminal pane, enter an existing absolute project path (or leave it blank for the user home
directory), then choose **Start session**. Closing a pane does not intentionally kill its process;
use the explicit **Stop** control to end it.

## Verify

```sh
pnpm ci:contract
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

Once committed to a GitHub remote, `.github/workflows/desktop.yml` runs on every push and pull
request. Its two stable checks are `macOS / product gate` and `Windows / product gate`; configure
both as required status checks for `main`. On trusted pushes, repository variables
`CI_MACOS_RUNNER` and `CI_WINDOWS_RUNNER` can select equivalent self-hosted runners without changing
the workflow. Pull requests always use ephemeral GitHub-hosted runners so PR code is not executed on
a persistent developer machine.

Both jobs run the renderer checks, Rust lint, and the native PTY round-trip tests. The macOS job
builds an unsigned `.app`. The Windows job exercises the Windows `cmd.exe`/ConPTY fixture, builds an
unsigned NSIS installer, and installs it into a clean runner profile. WebdriverIO then drives that
installed executable through project creation, one-click session start, PTY input/output, split,
and page creation. The script stops its sessions, runs the NSIS uninstaller, and removes only the
Windows-CI-specific WebView profile. It never deletes a pre-existing installation or user profile.

The checked-in CI contract parses the workflow as YAML and has mutation tests for disabled jobs,
filtered triggers, cancelled earlier runs, and non-blocking checks. This does not yet claim WSL
discovery and launch; WSL remains a per-session target of the Windows app, never a separate Talkak
build.

### GitHub merge enforcement

After adding the remote and pushing the first branch:

1. Let both desktop jobs complete once so GitHub registers their check names.
2. In the `main` ruleset, enable required status checks.
3. Require `macOS / product gate` and `Windows / product gate` and disallow bypass for normal merges.

Without the remote and those required checks, the workflow is only a checked-in test definition; it
cannot prevent a merge by itself.
