# Talkak Dev

A lightweight, cross-platform workspace for developers running several projects and local agent
sessions.

## First slice

This repository contains the interactive product shell and its first native runtime slice:

- project switching
- multi-pane workspace layouts
- backend-observed PTY status across panes, project counts, Sessions, inspector, and mobile views
- Korean/English UI switching with local preference persistence
- platform-aware shortcuts (`Command` on macOS, `Control` on Windows/WSL)
- an attention path for decision requests plus observed PTY errors and natural exits
- a cross-project Attention inbox with revision-checked local resolution previews
- session summary and conversation-preview inspector plus a real, read-only PTY log
- adaptive phone, tablet, and desktop presentations backed by the same session state
- a phone session view with conversation, terminal, summary, and unsent draft review
- optional app/project/session settings whose default is off
- native macOS / native Windows / Windows WSL runtime target model
- a provider-neutral native PTY boundary for spawn, write, read, resize, snapshot, kill, and discard
- an ANSI terminal loaded on demand only after a desktop session starts
- a rendered conversation log from the agent's own record: markdown, code-block and per-message
  copy, tool summaries, decisions, day separators, token usage, revision-aware refresh
- per-session agent activity (thinking, working with the last tool, needs input, done) on the pane,
  the page tab and the attention strip, with turn-complete notices in Attention and optional native
  OS notifications
- terminal conveniences: clickable `file:line` references opening a configured editor, copy-on-select
  that drops frame glyphs, OSC 52 clipboard, a scroll mode for mouse-owning programs, theme presets,
  stale mouse-mode release, a runtime log viewer, sessions with program and last activity
- command palette dispatch into the active session, project reorder, delete and reveal-in-folder,
  direct project jump chords, and a phone composer that sends
- an environment vault: keys and values entered once, app-wide or per project, delivered to every
  session as environment variables (secrets kept in the OS keychain, `TALKAK_ENV_KEYS` naming what
  arrived) so an agent reads them instead of asking
- self-update from GitHub releases, checked at launch and from Settings, installed on a click

The Tauri desktop app can start the operating system's default shell in an explicit absolute working
directory. Executables and arguments remain runtime configuration; no agent is hardcoded as the
product default. Live output replay is memory-bounded. A detached native broker keeps live processes
across an app restart, and the workspace reconnects to sessions that broker still owns.
Terminal output is pushed, not polled: a pane holds one dedicated broker connection per session,
the broker writes a frame the moment the PTY produces output, and the frame reaches the renderer as
raw bytes over a Tauri channel. A pane that returns from another page resumes at the byte it last
painted; nothing is replayed or duplicated. The renderer paints with xterm's DOM renderer on purpose:
the WebGL renderer breaks Korean IME composition in WKWebView.
After a PTY has fully exited, an explicit restart discards its old replay buffer before reusing the
session ID. A running session cannot be discarded. The Terminal Log inspector follows each runtime
run separately and reads the backend's most recent 1 MiB replay. The broker keeps bounded on-disk
records internally, but the product does not claim machine-restart session recovery.
Observed PTY errors and natural exits surface in Attention with their operation or exit code and
open that real terminal log. Exits requested with Talkak's Stop control do not create another
attention item. A reviewed runtime notice can be acknowledged for the current app run; a later
changed error observation appears again. These runtime facts do not claim that an AI task succeeded
or failed.
Local projects, page layouts, pane focus, generated session metadata, and the active project persist
without storing terminal output or launch arguments in the workspace snapshot. The native recovery
records are not exposed to the renderer. Transcript adapters, remote access, voice recognition, and
message sending are not claimed. The seeded projects, summaries, attention requests, and conversation
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

Once committed to a GitHub remote, `.github/workflows/desktop.yml` runs for pull requests targeting
`main`, direct pushes to `main`, and manual dispatches. A feature-branch push with an open pull
request therefore starts one gate set instead of duplicate push and pull-request runs. A newer run
for the same ref cancels its stale predecessor. Its two stable checks are `macOS / product gate` and
`Windows / product gate`; configure both as required status checks for `main`. On trusted pushes, repository variables
`CI_MACOS_RUNNER` and `CI_WINDOWS_RUNNER` can select equivalent self-hosted runners without changing
the workflow. Pull requests always use ephemeral GitHub-hosted runners so PR code is not executed on
a persistent developer machine.

Both jobs run the renderer checks, Rust lint, and the native PTY round-trip tests. The macOS job
builds an unsigned `.app`. The Windows job first builds the ordinary unsigned NSIS installer,
clean-installs it, and confirms the installed release process stays running. It then builds a
separate CI-instrumented NSIS installer. WebdriverIO drives that installed executable through
project creation in a fresh empty directory outside the checkout, one-click session start, PTY
input/output, split, page creation, natural process exit, runtime Attention, and retained terminal
log output. The macOS job additionally drives a streaming journey: a 40 000-line burst, a page switch
and return without duplicated output, the inspector's terminal log, and a restart from a clean screen.
Both gates read terminal text through xterm's buffer via CI-only hooks (`window.__talkakTest`,
compiled only in the `webdriver-ci` Vite mode) and paste commands rather than typing them, because
WebDriver's synthesised keystrokes reach xterm twice on WebKit. The scripts stop their remaining sessions, run the NSIS uninstaller, and remove only
profiles and test directories created by that run. They never delete a pre-existing installation or
user profile.

The installed-app test uses Tauri's WebdriverIO service and embedded WebDriver plugins behind the
non-default `webdriver-ci` Cargo feature. Its matching frontend adapter is compiled only in the
`webdriver-ci` Vite mode. Only the unsigned CI test installer enables those test layers; normal
development and release builds mechanically reject their markers in the product bundle. The
checked-in CI contract parses the workflow as YAML and has mutation tests for disabled jobs,
incorrect branch targets, retained stale runs, non-blocking checks, and accidental inclusion of
WebDriver in default product features. This does not yet claim WSL discovery and launch; WSL
remains a per-session target of the Windows app, never a separate Talkak build.

### Releases and self-update

A pushed tag `vX.Y.Z` runs `.github/workflows/release.yml`: it refuses a tag whose version differs
from `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, builds the macOS
`.app`/`.dmg` (signed and notarized when the Apple secrets exist) and the Windows NSIS installer,
signs the updater artifacts with the Talkak updater key, and publishes them as a GitHub Release
together with `latest.json`. Installed apps check that feed once at launch and from Settings, and
install only on a click. The secrets the workflow needs live in the repository settings; on the
owner's Mac, `bash scripts/release-secrets.sh <APPLE_API_ISSUER>` stores all of them from the
files already on disk (updater key, App Store Connect key, Developer ID certificate) — the only
value it cannot find on its own is the App Store Connect issuer ID.

To ship: bump the three version fields together, commit, `git tag vX.Y.Z && git push --tags`.

### GitHub merge enforcement

After adding the remote and pushing the first branch:

1. Let both desktop jobs complete once so GitHub registers their check names.
2. In the `main` ruleset, enable required status checks.
3. Require `macOS / product gate` and `Windows / product gate` and disallow bypass for normal merges.

Without the remote and those required checks, the workflow is only a checked-in test definition; it
cannot prevent a merge by itself.
