# Windows verification log

Every failure observed while bringing this repository up on a real Windows 11 machine, with the
evidence for each. Newest section first. This is a record, not law: it says what was seen and on
which build, never what someone should do.

Machine: Windows 11 Pro 26200, 12 cores / 15.4 GB RAM, WebView2 151.0.4129.107
(151.0.4129.93 during the earlier browser pass).
Toolchain: Node 24.15.0, pnpm 9.12.0, Rust 1.95.0 (pinned by `rust-toolchain.toml`),
MSVC 14.29.30133 (Visual Studio Build Tools 2019).
Branch: `agent/developer-workspace-ci`; this handoff work started from `3638780`.

---

## W-020 — A cancelled terminal write could repaint the same output after a page switch

**Severity:** high — repeated output and cursor crawl made ordinary terminal review unreliable.
**Status:** fixed in this branch.

The poller previously advanced its backend cursor independently of xterm's asynchronous write
callback. If a page switch or Stop transition cancelled the effect in that gap, the retained xterm
could still parse the submitted bytes while the backend cursor stayed behind; the next poll read and
painted those bytes again. React could also reuse one `SessionTerminal` instance for another session,
and replay/live chunks could change the cursor-query suppression flag before the prior chunk parsed.

Reads now serialize per session through `read -> xterm write -> cursor commit`. A write already
submitted to a retained emulator finishes across detach, while a queued write that never reached
xterm is abandoned. Foreground terminals are keyed by session id, protocol-input suppression is
session-scoped, and a truncation marker commits the backend's new start offset before a cancelled
poll can repeat it. Three focused writer tests pin detach, replay/live ordering, and real write-error
propagation. The isolated native Windows WebDriver flow then passed 1/1, including three PTYs, a page
switch, live output, Attention log review, Stop confirmations and focus restoration. The installed-
package run remains the clean-runner CI gate.

---

## W-019 — The packaged broker depended on an unbundled VC++ runtime

**Severity:** high — the app could install successfully and then fail to start sessions on a clean PC.
**Status:** fixed in this branch.

`dumpbin /dependents` showed that the packaged session broker imported `VCRUNTIME140.dll`; the app
executable itself did not. The Windows MSVC target now uses Rust's supported `crt-static` target
feature, avoiding a second installer and keeping the change outside macOS builds. The release
sidecar was rebuilt and its PE import table rechecked: `VCRUNTIME140.dll` is no longer present.

The NSIS bundle now includes only its two product languages, `English` and `Korean`. Tauri/NSIS
selects the operating-system language by default, so no extra first-run language dialog was added.
`tauri build --bundles nsis --no-sign --ci` produced a 5,657,976-byte installer; its generated NSIS
source contains both language macros and the release broker sidecar. `dumpbin /dependents` found no
`VCRUNTIME*.dll` or `MSVCP*.dll` import in either the release app or broker. The installer is still
unsigned because no signing certificate is available (W-001).

The local clean-install script was deliberately not run over the owner's active installation: it
uses the same install directory, bundle id and uninstall registry key, and correctly rejects that
non-clean precondition. Installation and WebDriver validation must run on the clean Windows CI
runner unless the owner first authorizes replacing the active app and its live broker sessions.

---

## W-018 — The renderer advertised a recovery path that no product screen used

**Severity:** medium — dead code claimed a restart workflow that would fail for live broker sessions.
**Status:** removed in this branch.

`sessionRecovery.ts` had no importer outside its own tests. Its `prepare()` path always built a
new spawn request under the stored session id, even when the broker still owned that id, and its
output read moved the entire retained tail through one JSON number array. The renderer module,
its unused `SessionClient` methods, the two unused Tauri commands and runtime wrappers, and tests
that only proved that dead facade were removed.

The actual recovery path is unchanged: workspace panes reattach to broker-owned sessions through
their live snapshot, and the orphan-session view lists and controls sessions the broker still
holds. The broker's bounded on-disk records remain an internal persistence primitive; this change
does not present them as a finished machine-restart feature.

---

## W-017 — Broker retirement could kill a newly connected client or orphan its shells

**Severity:** high — an app reconnect or broker upgrade could lose a live terminal boundary.
**Status:** fixed in this branch.

Client counting and process exit previously happened from a connection task's `Drop`: it could
observe zero clients while the accept loop already held a new OS connection but had not incremented
the global counter. `Shutdown` was also a permanent process-global bit, and `process::exit` skipped
the PTY cleanup owned by `SessionProcess`.

The accept loop now owns the client count and gives ready accepts priority over close events. A
per-connection flag follows `Shutdown` only to the connection that sent it; when that connection
closes the server returns normally, allowing the runtime and its PTYs to drop. Runtime mutex poison
is recovered and cleared once instead of making every later request fail while the broker remains
immortal. The broker suite passes 30 tests, including a real two-client shutdown boundary test and
a poisoned-lock recovery test. Those tests prove graceful server retirement and runtime drop; they
do not claim a separate live-child PID reaping integration test.

The client-side acquisition gap from the same review is also closed: when opening or starting the
broker fails before any product request is sent, acquisition retries once. Busy-pool and poisoned-
lock errors are still returned directly; only connection establishment gets the safe retry.

Connection/task/line backpressure remains the separate known risk recorded in HANDOFF §2.3; it was
not expanded into this shutdown fix.

---

## W-016 — Split-down used a different mnemonic on Windows

**Severity:** low — the same workspace action required memorising a different letter per OS.
**Status:** fixed in this branch.

Split-right was ⌘D / Ctrl+Shift+D, while split-down was ⇧⌘D / Ctrl+Shift+S. The Windows helper's
default Shift modifier caused the same-letter collision; changing the letter hid that implementation
detail in the user-facing keymap. Split-down is now Ctrl+Alt+D on Windows, preserving D on both
platforms while remaining distinct from split-right and ordinary terminal Ctrl+D.

---

## W-015 — “Open terminal log” opened the summary instead

**Severity:** high — the direct log-review action never showed the requested log.
**Status:** fixed in this branch.

The Attention detail button was labelled “Open terminal log”, but its desktop handler selected the
session and explicitly set the inspector to `summary`. The native E2E reached this path and waited
20 seconds for `terminal-log-view`; it never existed. The handler now opens the `terminal`
inspector mode named by the action. Phone mode already selected the terminal tab and was unchanged.

---

## W-014 — The Windows E2E assumed the default shell was `cmd.exe`

**Severity:** medium — the product gate blocked on a valid default PowerShell session.
**Status:** fixed in this branch.

The probe sent bare `echo` and waited for `ECHO is on/off.`, which is `cmd.exe` behaviour. This
machine correctly selected PowerShell 7 as its default shell; there `echo` aliases `Write-Output`
and, with no argument, prompts for `InputObject` instead. The gate now runs lowercase `whoami` and
compares the output with `whoami.exe` from the same Windows test process, so it remains valid for
both PowerShell and Command Prompt.

---

## W-013 — WebView2 WebDriver duplicated xterm text sent through W3C key actions

**Severity:** medium — the real Windows gate could not get past its first terminal command.
**Status:** fixed in this branch.

The first WebDriver run against a release build reached the live xterm textarea, focused it, and
sent the lowercase command `echo`. PowerShell received and attempted to execute `eecchhoo`; this
was not a display-only echo because PowerShell reported that exact doubled token as an unknown
command. The run stopped at the first terminal assertion, before any later workflow checks.

A controlled event trace showed one xterm-handled `keydown` per character with
`defaultPrevented === true`, followed anyway by a WebDriver-generated `input` event carrying the
same character. xterm correctly treated those as two input routes. The helper now uses WebDriver's
textarea value operation for the command text, which still crosses xterm's `input -> onData -> PTY`
path, and retains a native key action for Enter. No production keyboard handling changed.

---

## W-012 — The tablet layout rendered the entire main surface into a 0px grid track

**Severity:** high — the app looked blank at a normal narrow desktop width.
**Status:** fixed in this branch.

At a 767px viewport the responsive rule made the expanded sidebar absolute and changed the app
grid to `0px minmax(0, 1fr)`. Because the absolute sidebar no longer occupied column one, CSS auto
placement put `.app-main` into that 0px column. Browser measurement showed `main.width === 0` while
the pane existed and had content.

The tablet-only expanded-sidebar rule now pins `.app-main` to column two. Measured after hot reload:
the same 767px viewport gives the main surface the full 767px track, while the 720px phone boundary
still uses one 720px column with the sidebar hidden.

---

## W-011 — Stopping a session left its agent running blind, and `codex resume` locked out

**Severity:** high — reported from real use; the recovery path was also blocked.
**Status:** fixed in this branch (client-side immediately; engine-side with the next broker).

A pane's shell died (닫기/종료 or its window closing), but the agent CLI running inside it —
codex, mid-task since the previous day — survived the shell on Windows and kept working headless,
holding its own session file open. A later `codex resume` then failed with "thread … already has
an active writer": the orphan WAS the active writer, unreachable in any terminal.

`child.kill()` (and a dying ConPTY) reaches the shell, not the shell's descendants. Fixed by
sweeping the whole tree (`taskkill /T`, windowless, best-effort) after a kill, both in the app
client (effective against the currently-running broker generation) and in the engine (for the
next). Unix already gets this from SIGHUP to the session's process group.

Recovery for an existing orphan: `taskkill /PID <codex pid> /T /F`, then `codex resume` — the
rollout file carries the full conversation and the repository already holds the work.

---

## W-010 — A version-named broker copy pinned every later build to day one's binary

**Severity:** medium — invisible until a broker restart was expected to pick up fixes.
**Status:** fixed in this branch.

The app runs the broker from a copy named `talkak-dev-broker-<version>.exe` under the app data
directory (W-005's reinstall-lock fix). During development the version never moved, and the copy
was locked by the running broker — so the copy step silently kept day one's binary, and five
subsequent builds (including the broker's own lifecycle logging) never reached a newly spawned
broker. The copy name now carries the binary size alongside the version, so a changed build gets a
new file and a fresh spawn runs it. A LIVE broker is deliberately left alone: sessions outrank
freshness, and it is replaced the next time it exits idle.

---

## W-009 — CORRECTED: the broker never died; the monitoring searched the wrong process name

**Original claim (wrong):** a broker died silently, stranding three shells.
**What actually happened:** the broker process is named after its versioned copy —
`talkak-dev-broker-0.1.0`, not `talkak-dev-broker` — and every `Get-Process -Name
talkak-dev-broker` check missed it. Broker pid 27236, "dead" in the original entry, was alive the
whole time and at the time of this correction had kept sessions across five app reinstalls and
~23 hours, exactly as designed. The "orphaned shells" were its live sessions. The lifecycle-log
gap the original entry fixed is still real (and that broker generation predates the logging, so
its log's absence is expected — see W-010); the death it was written to explain never happened.
Kept as a record of the misdiagnosis.

**Severity:** high — the persistence layer's failure mode was unobservable.
**Status:** logging fixed in this branch; the death itself remains undiagnosed.

First real morning with the broker build (installed 10:26, launched ~10:40): reattach WORKED —
the user confirmed sessions survived an app restart. But by 11:0x the broker process (pid 27236)
was gone while three pwsh children it had spawned (10:42:39, 10:45:43, 10:53:22) were still
running, orphaned: a new broker has no handles to a dead broker's PTYs, so those shells can never
be reached again. Session logs were written up to 10:54:4x, then nothing.

The cause cannot be determined, and that is the finding: `spawn_detached` nulls stdio, so a
detached broker's panic, error or exit reason went nowhere. `exit_if_idle` should not fire with
running sessions; whether this was a panic unwinding through the serve loop, an OS-level kill, or
a logic hole is unknowable after the fact.

**Fix (observability):** `logging.rs` — an append-only lifecycle log at
`%APPDATA%\dev.talkak.desktop\broker\broker.log`: startup (version/endpoint/store), spawn/kill
requests, every connection close with the shutdown/running flags that feed the exit decision, the
idle-exit itself, server errors, and a panic hook. The next death will name itself.

**Left open:** orphan recovery. Stored session records do not carry child pids, so a fresh broker
cannot adopt or reap another broker's children; orphans accumulate silently. Recorded here as the
next broker work item.

---

## W-008 — Selecting text and pressing Ctrl+C did not copy; it interrupted the running process

**Severity:** high — reported from real use ("기본적인 복사도 안되냐").
**Status:** fixed in this branch.

On macOS this never showed: copy is ⌘C and interrupt is Ctrl+C, two different keys, and the
WebView's native copy path reaches xterm with no app code at all. On Windows the copy convention
and the interrupt are the *same key*, and xterm forwards Ctrl+C to the PTY as `\x03` immediately —
so selection copy was impossible and copying could kill whatever was running. Every terminal app on
Windows resolves this collision itself (VS Code, Windows Terminal); this repo had never needed to
because it was only ever used on a Mac.

**Fix.** `src/terminalClipboard.ts`, wired into both the live pane and the read-only log view,
settles it the way Windows Terminal does: Ctrl+C copies when text is selected and interrupts when
none is; Ctrl+Shift+C always copies; Ctrl+Shift+V pastes (plain Ctrl+V stays with the WebView's
native paste). macOS is `passthrough` for every rule — its behaviour is unchanged by construction.
Six unit tests pin the decision table, including the macOS no-op.

---

## W-007 — A pane with no configured command booted cmd.exe, where `ls` is "not recognized"

**Severity:** high — the first command a developer types fails.
**Status:** fixed in this branch.

portable-pty's `new_default_prog()` resolves the platform default: on Unix that is `$SHELL` (zsh on
the Mac this product was built on), on Windows it is `%COMSPEC%` — cmd.exe. So the same "leave the
command blank for the OS default terminal" choice gave a developer shell on macOS and a shell
without `ls`, `cat` or `rm` on Windows.

**Fix.** `default_shell_command()` in `session_runtime.rs`: on Windows resolve `pwsh.exe`, then
`powershell.exe`, from `PATH` (launched with `-NoLogo`; the user's profile still loads), falling
back to cmd only when neither exists. The non-Windows arm is `new_default_prog()` unchanged.
Locked by `the_default_windows_shell_is_a_powershell_when_one_is_installed`. Sessions spawned
before the fix keep the shell they started with; only new spawns pick up PowerShell.

---

## W-006 — Both font stacks were macOS-first, and Korean had no face named at all

**Severity:** medium — it is the first thing anyone sees.
**Status:** fixed in this branch.

`styles/foundation.css` carried
`Inter, Pretendard, "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif` for the UI
and `"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace` for `--mono`, which 57
rules use. Neither `Inter` nor `Pretendard` is bundled — the repository contains no `@font-face` at
all — so on any ordinary machine both are skipped and the first real entry decides everything:
`SF Pro Display` on macOS, `Segoe UI` on Windows.

**Segoe UI carries no Hangul.** Every Latin monospace in the `--mono` stack lacks it too. So Korean
fell through to whatever the engine picked, and Latin and Korean rendered in two different families
side by side. On macOS the Apple faces happen to pair cleanly, which is why this never showed up
there.

**Fix, first pass.** Both stacks named a Korean face per platform — `"Apple SD Gothic Neo"`,
`"Malgun Gothic"`, `"Noto Sans KR"`. That repaired the mismatch but left macOS and Windows looking
like different products, because they still resolved to different families.

**Fix, second pass — the product now ships its own typefaces.** A system stack cannot be made
identical across platforms, so `src/assets/fonts/` carries them:

| face | role | bytes |
|---|---|---|
| Pretendard Variable | UI, Latin and Hangul in one family, weights 45–920 | 2,057,688 |
| JetBrains Mono Regular / Bold | terminal Latin | 92,164 / 94,588 |
| D2Coding Regular / Bold | terminal Hangul, `unicode-range`-limited so it is consulted only for what it is for | 357,244 / 396,424 |

All three are SIL OFL 1.1, which permits bundling inside commercial software; the licence texts sit
beside the files. `styles/fonts.css` declares them and is imported ahead of every other sheet in
`main.tsx`. Cost: the executable went 9,620,480 → 12,606,464 bytes and the installer 2,203,352 →
5,231,319.

`src/terminalTheme.ts` holds one `TERMINAL_FONT_FAMILY` and one `TERMINAL_THEME`, imported by both
`SessionTerminal.tsx` and `TerminalLogView.tsx`, so the live pane and the read-only log cannot
drift apart.

**Fix, third pass — two causes that had nothing to do with the font file.** Bundling correct faces
changed less than expected, because two other things were mangling Korean:

1. **Latin tracking on Hangul.** 17 rules carried positive `letter-spacing`, up to `0.18em`. That
   is eyebrow styling for Latin; Hangul is already evenly spaced by design, so the same value pulls
   a Korean label apart and reads as a rendering fault. Every positive value is now
   `calc(<value> * var(--tracking))`, with `--tracking: 1` normally and `0` under `:root:lang(ko)`
   — `i18n.tsx:648` already keeps `documentElement.lang` in sync with the interface language, so
   this follows the language switch. `.brand span`, `kbd` and `code` opt back in, being Latin
   whatever the language. The 7 negative values are untouched; they suit both scripts.
2. **The whole launcher was fixed-width.** `workspace.css:532` sets `font-family: var(--mono)` on
   `.terminal-pane__body`, which is correct for terminal output — but the launcher element carries
   both `terminal-pane__body` and `terminal-launcher`, so its Korean labels, button and explanatory
   sentence inherited a monospace face. `.terminal-launcher` now declares `var(--sans)`; the
   working-directory input, profile name and command inside it keep `--mono`, being paths and code.

Measured on the same pixels at the same zoom: before, syllables sat in evenly spaced cells; after,
they set tightly and the notice fits on one line where it previously wrapped.

**Left open, a design question rather than a defect:** `var(--mono)` still reaches Korean text in
other surfaces — inspector eyebrows, session table heads, mobile session view. The same treatment
applies wherever the copy is prose rather than code.

---

## W-005 — A pane spawned with no terminal identity, so colour-capable CLIs went monochrome

**Severity:** medium.
**Status:** fixed in this branch.

`command_for_request` (`src-tauri/src/session_runtime.rs`) set the working directory and arguments
and nothing else. `portable-pty`'s `get_base_env()` (`cmdbuilder.rs:74`) inherits
`std::env::vars_os()` and, on Unix only, fills in `SHELL` when absent — **it never sets `TERM` on
either platform.** A Windows GUI process carries neither `TERM` nor `COLORTERM`, so a BYO agent CLI
had no way to know it was attached to a colour terminal.

Separately, the xterm theme named only `background`, `foreground`, `cursor` and
`selectionBackground`. With no ANSI palette, xterm falls back to a stock one designed for pure
black, so what colour did appear read muddy against `#071216`.

The code gap is identical on both platforms; the symptom is worse on Windows because more tooling
there gates colour on `TERM` rather than on `isatty()` alone.

**Fix.** The spawn now sets `TERM=xterm-256color` and `COLORTERM=truecolor`, locked by
`a_spawn_tells_the_child_it_is_talking_to_a_colour_terminal` in `session_runtime_tests.rs`. All
sixteen ANSI colours are defined in `src/terminalTheme.ts`.

Note: `session_runtime.rs` was already 722 lines before this change, over the 700-line budget in
AGENTS.md §5. This added five. It should be split by responsibility rather than grown further.

---

## W-004 — A saved launch command that resolves nowhere reached `CreateProcessW`

**Severity:** high — this is the first-run path for a new user.
**Status:** fixed in this branch.

A project was created with `test` typed into **실행 파일 또는 명령** / *Executable or command*.
Nothing rejected it, and **세션 시작** produced this inside the pane:

```
session process error: CreateProcessW `"test\0"` in cwd `Some("C:\\Sources\\test\0")`
failed: The system cannot find the file specified. (os error 2)
```

Three separate problems in one line:

1. `ProjectDialog.tsx` validated the project folder through `projectClient.validatePath()` but
   applied no check at all to the command, so an unresolvable executable was saved.
2. The failure surfaced as a raw Rust debug string, including the `\0` that `portable-pty` carries
   in its null-terminated wide command line. Nothing about it tells a user what to do.
3. Recovering required opening project settings and clearing a field by hand.

Nothing here is Windows-specific. `ProjectDialog.tsx` is platform-neutral TypeScript, and the same
mistake on macOS produces the same raw failure with `posix_spawn` in place of `CreateProcessW`. It
went unnoticed because whoever built the product knows to leave that field blank.

**Fix.** `project_validate_command` in `src-tauri/src/project_commands.rs` resolves a command the
way a shell would — absolute or separator-bearing paths directly, bare names through `PATH`, and on
Windows through `PATHEXT` as well — and an empty command stays valid because that is the documented
"OS default terminal" choice. `ProjectDialog.tsx` now calls it beside the folder check, so a bad
command is refused in the dialog.

**First attempt at the recovery was wrong and was replaced.** It added a second **기본 터미널로 시작**
button beside **세션 시작**, which left a button on screen that was guaranteed to fail for exactly
the users who needed help. `SessionTerminal.tsx` now validates the saved command when the launcher
appears and keeps a single button: it reads **세션 시작** when the command resolves, and
**기본 터미널로 시작** with a plain-language explanation when it does not.

---

## W-003 — `native_pty_closes_after_command_exits_without_kill` is flaky under load

**Severity:** medium — wrong exit codes reach the product's Attention surface.
**Status:** root race open; user-facing presentation mitigated in this branch.

```
session_runtime_tests::native_pty_closes_after_command_exits_without_kill
  left:  Some(3221225786)   // 0xC000013A STATUS_CONTROL_C_EXIT
  right: Some(7)
```

Measured on this machine:

| how it was run | result |
|---|---|
| test alone, 5 consecutive runs | 5 passed |
| full `cargo test --lib`, 8 consecutive runs | 7 passed, 1 failed |
| full suite, first run of the session | failed |

A separate process-level stress run then reproduced the baseline once in 32 runs. Starting the PTY
reader before the child still failed 2 of 64, and pre-queuing the cursor-position response also
failed 2 of 64, always with the same `0xC000013A`. Both speculative runtime changes were removed.

So roughly 2 failures in 9 full-suite runs, and never in isolation — a race that only appears when
all 22 tests contend for the machine. The fixture is
`cmd.exe /D /S /C exit /B 7` (`session_runtime_tests.rs:398`), which exits almost immediately.
`0xC000013A` is what a console process reports when it dies from a console control event rather
than returning on its own, so the ConPTY teardown is racing the child's natural exit.

`refresh_status()` (`session-broker/src/runtime.rs:504`) records whatever `try_wait()` returns at
that instant and makes no distinction between "exited on its own" and "was terminated by a console control
event". README states that observed exits surface in Attention with their exit code, so a
short-lived process under load can show `3221225786` to a user.

The precise trigger has not been isolated. The shipped minimal mitigation recognizes
`0xC000013A` as an interrupted Windows console process and shows **Interrupted / 중단됨** in both
the terminal phase and Attention detail instead of the misleading decimal `3221225786`. No retry,
wrapper process, dependency fork, or unproven teardown change was added.

---

## W-002 — CORRECTED: the product gates have run on pull request #1

**Original claim (wrong):** CI had probably never run because branch pushes do not match the
workflow's `main` filter.
**Status:** corrected; run #37 is green on both macOS and Windows.

The repository has an open pull request from `agent/developer-workspace-ci` to `main`, so the
`pull_request` trigger does match. Run #36 for `4756626` completed the entire Windows product gate,
including the release installer clean-install smoke and the installed-product WebDriver E2E. The
macOS job reached its native tests and then found that
`two_spellings_of_one_directory_match` incorrectly expected Windows case folding on every OS.
The test now checks separator and trailing-slash normalization everywhere, case folding on Windows,
and case preservation on macOS/Unix. Run #37 for `42874e1` then passed both product gates: 34
renderer test files / 189 tests per OS, broker and native Rust checks, the macOS app bundle, the
Windows release installer clean-install smoke, and the installed-product WebDriver E2E.

---

## W-001 — Packaging gaps that CI structurally cannot catch

**Severity:** high for a paid product.
**Status:** VC++ runtime and Korean installer fixed; signing blocked on a certificate.

`src-tauri/tauri.conf.json` now carries the product's explicit NSIS language choice, and the Windows
MSVC target uses static CRT linkage.

1. **Unsigned installer.** Both CI and local builds pass `--no-sign`. A buyer downloading the NSIS
   installer meets SmartScreen's "Windows protected your PC" screen and has to click through
   *More info → Run anyway*. This needs a code-signing certificate. Neither CurrentUser nor
   LocalMachine has a usable code-signing certificate on this machine, and no signing/Azure
   credential environment is configured, so this cannot be completed honestly in code.
2. **VC++ runtime: fixed.** `.cargo/config.toml` enables Rust's supported `crt-static` target
   feature only for Windows MSVC. The rebuilt app and broker PE import tables were inspected and no
   longer name `VCRUNTIME` or `MSVCP` DLLs.
3. **Installer language: fixed.** NSIS now embeds `English` and `Korean`; the generated installer
   source was checked after a real bundle build.

Working as intended and worth keeping: the NSIS default `installMode` is `currentUser`, so the app
lands in `%LOCALAPPDATA%\Talkak Dev` and installation raises no UAC prompt.
`verify-windows-package.ps1` already assumes that path.

---

## Notes on failures that were not product defects

- **The first E2E wrapper was rejected before launch by the command policy.** It combined product
  execution, broker cleanup and recursive deletion in one shell. The work was split into explicit
  run, exact-session discard and filesystem cleanup commands; no app or directory was created by the
  rejected command. `New-Item -LiteralPath` then failed because that cmdlet takes `-Path`; correcting
  that parameter allowed the product test to run.
- **Recursive cleanup of the isolated E2E directory was also rejected by policy.** The directory was
  resolved under `%TEMP%`, inspected as empty, and removed non-recursively by its exact literal path.
  The three stopped sessions whose stored `cwd` exactly matched that directory were discarded first;
  zero matching records remain and the owner's nine running sessions are unchanged.
- **`pnpm` was not on PATH when the packaging preflight queried it.** `Get-Command pnpm` failed as
  HANDOFF warned. Corepack shims were generated under a task-owned temporary directory and only
  prepended for the build process; no global install or shell-profile change was made.
- **Rust 1.95 clippy rejected `sort_by(|a, b| a.run_id.cmp(&b.run_id))`.** It was the standard
  `unnecessary_sort_by` lint under `-D warnings`; replacing it with `sort_by_key` made both broker
  clippy and its 30-test suite pass without changing order.
- **The first typecheck of the detach-safe terminal writer failed with `TS18048`, and Biome also
  rejected one import order.** The optional cursor lookup is now explicitly narrowed and the import
  sorted. A later focused Biome pass rejected one multiline assertion; it was formatted and rerun.
- **Two combined documentation patches missed exact wrapped-line contexts and applied nothing.**
  They were split into narrow patches, then `git diff --check` and the rendered text were rechecked;
  product files were not touched by either failed patch.
- **Waiting for ConPTY's initial cursor exchange before spawning the child always timed out.** The
  first W-003 experiment assumed the query was observable immediately after pseudoconsole creation.
  On this Windows build it was not emitted until a client process was attached, so the two-second
  startup wait was removed rather than shipped as latency in every new pane.
- **Neither starting the PTY reader before the child nor pre-queuing the cursor-position response
  fixed W-003.** The original stress run failed 1 of 32; each experiment still failed 2 of 64 with
  exactly `0xC000013A`. Both speculative runtime changes were removed.
- **The Windows E2E clicked Stop but did not confirm the destructive action.** The product correctly
  kept the PTY alive behind its confirmation dialog, while the stale helper waited for an exited
  phase. The helper now opens the dialog and clicks its danger action before waiting.
- **The Windows E2E diagnostic warned that `tauri-driver` was missing even though the embedded
  driver then started and opened the app.** The preflight and the actual runner disagree about the
  embedded-driver path; keep the warning until that diagnostic is corrected.
- **WebdriverIO cleanup warned `Failed to clear mock store: A sessionId is required` after both a
  failed run and the final successful run had already deleted their WebDriver sessions.** This is
  teardown noise after the product assertion result, but the service cleanup order should be made
  idempotent upstream.
- **The first typecheck after making terminal writes report completion failed with `TS7006`.**
  The local `finish(written)` callback lacked its explicit `boolean` annotation. Add the annotation
  and rerun the typecheck; no runtime code changed.
- **The browser verification adapter rejected `networkidle` while opening the Vite preview.**
  Although the browser API advertises that load state, this connected Chrome adapter returned
  `playwright_wait_for_load_state does not support networkidle`. Continue with
  `domcontentloaded` and an explicit DOM assertion.
- **Starting `pnpm dev` through the verification shell with PTY allocation failed before Vite
  launched.** `CreateProcessW` returned `-1073283067` while creating the PowerShell wrapper. This
  was a verification-runner launch failure, not a Talkak process error; retry without PTY
  allocation.
- **NSIS packaging failed with `os error 32`.** `pnpm tauri build --bundles nsis` finished the Rust
  release build in 2m41s, then `makensis` could not read `talkak-dev.exe` because that executable
  had just been launched by hand. Build the bundle with the app closed.
- **`winget install Microsoft.VisualStudio.2022.BuildTools` exited 6** (installer 1602, user exit).
  It was never needed: Build Tools 2019 with `VC.Tools.x86.x64` was already present and links this
  project fine. An earlier report that MSVC was missing came from calling `vswhere` with several
  names in a single `-property` argument, which silently returns nothing.
