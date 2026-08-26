# Windows verification log

Every failure observed while bringing this repository up on a real Windows 11 machine, with the
evidence for each. Newest section first. This is a record, not law: it says what was seen and on
which build, never what someone should do.

Machine: Windows 11 Pro 26200, 12 cores / 15.4 GB RAM, WebView2 151.0.4129.93.
Toolchain: Node 24.15.0, pnpm 9.12.0, Rust 1.95.0 (pinned by `rust-toolchain.toml`),
MSVC 14.29.30133 (Visual Studio Build Tools 2019).
Branch: `agent/developer-workspace-ci` at `bc8fd5b`.

---

## W-009 — A broker died silently, stranding three live shells, and left no way to know why

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
**Status:** open.

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

So roughly 2 failures in 9 full-suite runs, and never in isolation — a race that only appears when
all 22 tests contend for the machine. The fixture is
`cmd.exe /D /S /C exit /B 7` (`session_runtime_tests.rs:482`), which exits almost immediately.
`0xC000013A` is what a console process reports when it dies from a console control event rather
than returning on its own, so the ConPTY teardown is racing the child's natural exit.

`refresh_status()` (`session_runtime.rs:456`) records whatever `try_wait()` returns at that instant
and makes no distinction between "exited on its own" and "was terminated by a console control
event". README states that observed exits surface in Attention with their exit code, so a
short-lived process under load can show `3221225786` to a user.

The precise trigger has not been isolated. Candidates not yet ruled out: the timing of
`close_master_async()` relative to the child's exit, and `drop(pair.slave)` at
`session_runtime.rs:275`. This needs a targeted repro before anyone changes the teardown.

---

## W-002 — The product gates have probably never run on this code

**Severity:** high — every claim of Windows verification rests on CI.
**Status:** open, needs confirmation.

`.github/workflows/desktop.yml` triggers only on `push: branches: [main]` and
`pull_request: branches: [main]`. All 28 commits live on `agent/developer-workspace-ci`, and `main`
is still `df9a4ca Initial commit` carrying nothing but `README.md`. Unless a pull request was
opened, `macOS / product gate` and `Windows / product gate` have never executed against this code.

Not confirmed from this machine: `gh` is unauthenticated here, so the run history was not read.

---

## W-001 — Packaging gaps that CI structurally cannot catch

**Severity:** high for a paid product.
**Status:** open.

`src-tauri/tauri.conf.json` carries no `bundle.windows` section at all, so every Windows packaging
decision is a Tauri default.

1. **Unsigned installer.** Both CI and local builds pass `--no-sign`. A buyer downloading the NSIS
   installer meets SmartScreen's "Windows protected your PC" screen and has to click through
   *More info → Run anyway*. This needs a code-signing certificate; no amount of code fixes it.
2. **No VC++ runtime bundled.** The Rust MSVC target links `vcruntime140.dll` and friends
   dynamically. GitHub's `windows-latest` runners always have them, so the clean-install smoke in
   `verify-windows-package.ps1` cannot fail for their absence — the gap is invisible to CI by
   construction. This machine had the DLLs present in `System32` but no VC++ redistributable
   registry entry, which is closer to an ordinary user's machine than the runner is.
3. **English-only installer.** `nsis.languages` is unset, so a Korean buyer gets an English
   installer for a product whose UI ships Korean.

Working as intended and worth keeping: the NSIS default `installMode` is `currentUser`, so the app
lands in `%LOCALAPPDATA%\Talkak Dev` and installation raises no UAC prompt.
`verify-windows-package.ps1` already assumes that path.

---

## Notes on failures that were not product defects

- **NSIS packaging failed with `os error 32`.** `pnpm tauri build --bundles nsis` finished the Rust
  release build in 2m41s, then `makensis` could not read `talkak-dev.exe` because that executable
  had just been launched by hand. Build the bundle with the app closed.
- **`winget install Microsoft.VisualStudio.2022.BuildTools` exited 6** (installer 1602, user exit).
  It was never needed: Build Tools 2019 with `VC.Tools.x86.x64` was already present and links this
  project fine. An earlier report that MSVC was missing came from calling `vswhere` with several
  names in a single `-property` argument, which silently returns nothing.
