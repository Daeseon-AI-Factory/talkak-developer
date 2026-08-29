# Handoff — Talkak Dev, Windows

Written 2026-08-29 for whoever picks this up next. Branch `developer-workspace-ci`,
pushed to `origin/agent/developer-workspace-ci` at `51fe2de`. Working tree clean.

The owner's standing rules, which override convenience:

- The product must behave **identically on macOS and Windows**. WSL is a session target, not a
  build target. A platform split is a defect unless it is a genuine OS convention.
- Nothing may require the owner to do things by hand. Install the build yourself; do not hand over
  files.
- **Never claim something is fixed without verifying it.** This has been the single biggest source
  of frustration in this session, mine included.
- Every error encountered gets recorded (`docs/windows-verification-log.md`).
- Confirm before anything destructive.

---

## 1. The one thing blocked on a human decision

**Terminal colour is fixed in code but not live.**

`NO_COLOR=1` reaches every pane. It is in neither the user nor the machine environment — it comes
from the terminal the app was launched from (an agent shell), and the broker is what makes that
permanent: it outlives the app, so one launch's environment is stamped on every shell it ever
opens. PowerShell sees it and sets `$PSStyle.OutputRendering = PlainText`, which strips SGR from
all command output. Verified twice: by driving the broker over its own pipe and dumping raw PTY
bytes (`Write-Host -ForegroundColor Red` came out with no SGR at all, while a hand-written escape
survived), and by reading the live processes' PEB environment blocks.

The fix is committed (`d726021`): `command_for_request` in `session-broker/src/runtime.rs` now
`env_remove`s `NO_COLOR` and `ANSI_COLORS_DISABLED`, and `CLICOLOR` only when it is `"0"`.

**Why it is not live:** the running broker is `talkak-dev-broker-0.1.0-1121792.exe`, PID 54032,
started 2026-08-28 16:31 — before that fix. `PROTOCOL_VERSION` is unchanged, so the client adopts
it rather than retiring it. Replacing it means ending what it holds:

    8 shells: 3 × claude.exe, 4 × codex.exe, 1 idle prompt

**Do not kill these without the owner saying so.** Either they say go, or the broker retires itself
once those sessions end and the app is closed (`exit_if_idle`, `session-broker/src/server.rs`).

Immediate relief for one already-open pane, losing nothing: `$PSStyle.OutputRendering = 'Ansi'`.

When you next launch the app yourself, scrub the environment first or you recreate the problem:

```powershell
foreach ($n in 'NO_COLOR','CLAUDECODE','AI_AGENT','CLICOLOR','ANSI_COLORS_DISABLED') {
  Remove-Item "Env:$n" -ErrorAction SilentlyContinue
}
```

---

## 2. Reported and NOT fixed — start here

### 2.1 "스크롤이 똑바로 안 먹힌다" — still reported after `51fe2de`

The owner says it is unchanged. The running app **is** that build (exe written 19:06:02, process
started 19:06:30), so the four fixes below are live and did not resolve the symptom. Treat the
diagnosis as incomplete, not as done.

What was found and changed (all evidenced, none of it confirmed to be *the* cause):

1. `.terminal-host` had `min-height: 140px` inside an `overflow: hidden` parent, so a squeezed pane
   made xterm size itself taller than its box and clip the bottom rows permanently — scrolling down
   never reached the prompt. Floor moved to `.terminal-pane` in `shell-layout.css`.
2. The fitter's scroll restore ran before xterm 6's viewport re-based its scroll dimensions, so
   `scrollToLine` used stale geometry. Deferred one frame in `src/terminalFit.ts`, and narrowed —
   xterm 6's reflow already preserves a scrolled-up reader's absolute line.
3. `windowsPty` was never passed to the `Terminal` constructor. Now supplied from `host_info`
   (`src/runtime/hostClient.ts`).
4. `.xterm-viewport` is not the scroller in xterm 6; the CSS was styling a dead element.

**What has NOT been done, and should be next:** nobody has watched the actual failure. Ask the
owner precisely what happens — wheel does nothing? scrolls then snaps back? only in split panes?
only while output streams? — then reproduce it in the browser preview (`pnpm dev`, port 1420) where
devtools work. Note the Chrome extension could not reach `localhost:1420` in this session; a normal
browser window is fine.

One strong lead was found and **not implemented** (it is the most invasive of the set):

> The poll loop writes a chunk into xterm and can then abandon the cursor advance, so the same
> bytes are read and written a second time. Trigger: a page switch, Stop, or a
> running→stopping→exited transition while output is streaming.
>
> Fix: make `TerminalOutputWriter` return `Promise<boolean>`; `finish(written)` resolves `true`
> only from xterm's own write callback and `false` from the dispose sweep and the `disposed`
> short-circuit; advance the cursor per chunk instead of once at the end.
> — `src/components/SessionTerminal.tsx`

That would produce duplicated output and a jumping viewport, which matches the complaint well.

### 2.2 xterm still has no GPU renderer

xterm 6 ships only the DOM renderer. There is **no `@xterm/addon-webgl` published for 6.0.0** —
every `0.19.x` targets xterm 5, and every `0.20.0-beta.N` peers on `@xterm/xterm ^6.1.0-beta.N`.
`@xterm/addon-canvas` peers on `^5.0.0`. Options: stay on the DOM renderer, or move the core to the
6.1 beta line and take a beta dependency in a product being sold. **That is the owner's call, not
ours.** `screenReaderMode` was found on and turned off (it mirrors the viewport into live DOM and
does per-line work as output arrives); that part is done.

### 2.3 Known-open defects with anchors

From two adversarial review passes. Each was independently verified; none is fixed.

**Broker (`session-broker/src/server.rs`)**

- Idle-exit TOCTOU: `exit_if_idle` calls `std::process::exit(0)` without re-checking `LIVE_CLIENTS`,
  so it can kill a client that has already connected and sent its first request. The connection
  exists at the OS level before `serve_detached` increments the counter.
- `SHUTDOWN_REQUESTED` is a process-global `AtomicBool`, never cleared and not scoped to the
  connection that sent `Shutdown` — contradicting the protocol's own contract ("exit once THIS
  connection closes"). `process::exit(0)` also skips `Drop` for `SessionProcess`, orphaning shells
  rather than reaping them.
- A poisoned session-registry mutex bricks the broker permanently: `has_running_sessions()` returns
  `true` on poison so it can never retire, and `Hello` is answered from constants so the client's
  protocol check passes and never retires it either. (`runtime.rs`)
- No backpressure: no connection cap, no task cap, no line-length cap.

**Client (`src-tauri/src/session_runtime.rs`)**

- `request()`'s retry loop does not cover connection establishment — `self.acquire()?` propagates
  out, so the failure the doc comment claims to absorb reaches the user as a hard error.

**Recovery (`src/runtime/sessionRecovery.ts`)**

- The whole module is dead code: no importer outside its own test.
- It treats every persisted record as relaunchable, but the store also holds records for sessions
  the broker still has, so after a normal app restart `prepare().relaunch` is rejected with
  "session already exists". The client is deliberately narrowed so the service structurally cannot
  check liveness.
- `readOutput` pulls up to the full retained tail (now 8 MiB) in one IPC call, serialised as a JSON
  array of individual numbers — roughly 3.3 bytes of JSON per payload byte — while the live read
  path on the same runtime is capped at 64 KiB per RPC.

**Keyboard parity (`src/shortcutRegistry.ts`)**

- `splitDown` uses a different *letter* per platform (macOS ⇧⌘D, Windows Ctrl+Shift+S). Not an OS
  convention — it is forced by the `windows()` helper hard-coding shift, which collapses ⇧⌘D and ⌘D
  onto one Windows chord. This violates the parity rule; give it a distinct modifier, not a
  distinct key.

**Store rotation (`session-broker/src/store.rs`)**

- Rotation cuts the retained tail at an arbitrary byte offset, so the first bytes handed back can be
  a truncated UTF-8 codepoint or half an escape sequence. Nothing sanitises it before it would be
  written to a terminal.

### 2.4 Shipping, untouched since the log was opened

`docs/windows-verification-log.md` W-001..W-011. Still open: installer is unsigned (SmartScreen on
first run for every buyer), the VC++ runtime is not bundled, the NSIS installer is English-only,
CI has never run on this branch (W-002), and the `0xC000013A` exit-code race (W-003).

---

## 3. What landed this session, and what proves it

Nine commits, `d726021..51fe2de`.

| Commit | What |
|---|---|
| `d726021` | Colour: broker strips `NO_COLOR`/`ANSI_COLORS_DISABLED`, and `CLICOLOR=0` only |
| `7b9b082` | Paste correctness + the app-wide freeze |
| `f211f46` | Page-close and live-pane-close confirmation |
| `6457e1b` | Store bounds checked against the Rust that enforces them |
| `f1f9fd7` | Broker copy keyed by content; three error-swallowing sites fixed |
| `5ad68ff` | Every client wait bounded, Windows included |
| `2aa7746` | Summary + conversation log filled from the agent's own record |
| `798311c` | One paste, both platforms, once |
| `51fe2de` | The four scroll findings above |

Highlights worth knowing because they were *not* obvious:

- **Paste was wrong three ways.** It asked for an image before text, and Windows puts CF_DIB on the
  clipboard beside the text for any rich copy — so copying from a browser or Excel pasted the path
  of a PNG the user never took. The path was pasted unquoted, so a profile folder with a space
  broke it. And each paste wrote a new multi-megabyte PNG named by wall clock, under a comment
  claiming the name deduplicated them.
- **One keystroke pasted twice.** The key handler returned `false` to xterm but never called
  `preventDefault`, and Ctrl+Shift+V is Chromium's own "paste as plain text".
- **The app-wide freeze was real.** The broker ran every request inline on a tokio worker, and the
  heavy arms all block (openpty + CreateProcess, a PTY write under the process writer, waiting on a
  child, reading a whole file). One shell that stopped draining its input parked a worker; a few
  starved the runtime and every other pane's reads stopped. Plus the write-priority gate was one
  process-wide counter with an unbounded wait that could go negative and never release. Both fixed.
- **The broker's freshness check could not fail.** The installed copy's filename carried the source
  byte length, so `meta.len() == source_len` was true of any complete file at that path. Any
  rebuild that did not change the size silently reused the old binary. Now keyed by content digest.
- **`MAX_LOG_BYTES` drifted 4 MiB → 8 MiB with no test failing**, because the guard compared
  TypeScript literals with TypeScript literals. `src/runtime/storeBounds.test.ts` now reads
  `store.rs` itself.

### The transcript adapter (`src-tauri/src/agent_transcript.rs`)

The summary and conversation panels had been empty since extraction — `conversation` is initialised
to `[]` and nothing ever appended; the only writer of either was `demo.ts`. They now read the
agents' own JSONL records. Format notes, verified against real files on this machine:

- **Claude Code**: `~/.claude/projects/<key>/<sessionId>.jsonl`, where `<key>` is
  `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, truncated at 200 chars with a base-36 hash of the *original*
  path appended. Case is preserved, but the directory must be found by **enumerating and matching
  case-insensitively** — Windows and default APFS fold two drive-letter spellings into one
  directory.
- One assistant answer is written as **several lines, one per content block**, all sharing
  `message.id` — 483 of 895 in one real file here. They must be folded or one reply renders as up
  to five bubbles.
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The cwd is not in the path; it is in
  line 0's `session_meta.payload.cwd`. Critically, **91 of 100 rollout files are subagent threads
  that record the same cwd as their parent** — the main thread is the one whose
  `session_meta.payload.thread_source == "user"`.
- Sizes are large: 15.5 MB for one session, one line reaching 611 KB, and only ~2% of it renderable
  text. Parse in Rust, never in the renderer.

**Not done here:** `summary.decisions` and `summary.progress` are still demo-seeded. Nothing in the
records supports them honestly. Either derive something real or remove them; do not fabricate.

---

## 4. Traps that cost time in this session

- **`pnpm` is not on PATH.** `tauri.conf.json`'s `beforeBuildCommand` uses it. Provision it with
  `corepack enable pnpm --install-directory <dir>` and prepend that dir to PATH.
- **`bundle.active` is `false`** in `tauri.conf.json` and has been since the first commit, so
  `tauri build` produces **no installer**. Use `npx tauri build --bundles nsis`.
- **`broker_binary()` prefers `session-broker/target/debug/` over `release/`.** A stale debug build
  makes `src-tauri`'s client tests launch an old broker and fail with "broker kept answering with
  an incompatible protocol". Run `cargo build` in `session-broker/` after changing the protocol.
- **The broker's PTY tests are contention-sensitive.** They spawn a shell each; under `cargo test`'s
  default parallelism a cold `pwsh` start blew the old 5s deadlines. `PTY_WAIT` is 30s now. If they
  fail, retry with `--test-threads=1` before believing the failure.
- **Two agents editing one file.** Claude and codex both worked this repo concurrently, and
  `session_runtime.rs` and `runtime.rs` were each overwritten mid-edit more than once — one commit
  lost an acquire-timeout entirely, and at one point codex's own edit broke codex's own test.
  Before editing a file, check `git diff` on it. Commit and push narrow changes promptly.
- The auto-mode classifier blocks some commands (`taskkill` on a user process, `git update-index
  --cacheinfo`). Ask the owner to run those.

## 5. Suggested order

1. Ask the owner for the colour go-ahead (§1). One question, unblocks a visible fix.
2. Reproduce the scroll fault with them watching (§2.1), then decide whether the double-write lead
   is it. Do not ship another speculative fix.
3. `splitDown` parity (§2.3) — small, and it violates a stated rule.
4. Broker shutdown correctness (§2.3) — TOCTOU, `SHUTDOWN_REQUESTED` scope, poisoned-lock brick.
5. Decide `sessionRecovery.ts`: wire it or delete it. Dead code that claims a capability is worse
   than no code.
6. Signing, VC++ runtime, and CI (§2.4). This is being sold; SmartScreen on first run is a real
   cost to every buyer.

---

## 6. Late corrections to §3's transcript notes

Found by reading Claude Code's shipped bundle rather than inferring from files. Both were real bugs
in the code committed here and are fixed in `f9d0ab0`; recorded because the next person will hit
the same traps.

- **Sanitise per UTF-16 code unit, not per char.** The harness uses a JavaScript regex with no `/u`
  flag, so an astral character (an emoji in a path) is two units and becomes *two* dashes. Hangul
  is in the BMP and is unaffected, which is why a Korean path did not expose this.
- **`Math.abs` in base 36 needs a wider integer.** `i32::MIN.wrapping_abs()` is still `i32::MIN`,
  so a `while value > 0` loop emitted an empty suffix and a directory name ending in a bare dash.
  JavaScript answers `"zik0zk"`. Widen to `i64` before taking the magnitude.

Two env overrides exist and are **not** implemented here:

- `CLAUDE_CONFIG_DIR` replaces `~/.claude` as the root.
- `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the computed key entirely, honoured only when
  `CLAUDE_CONFIG_DIR` is also set, and validated against `/^[A-Za-z0-9_-]{1,64}$/` with Windows
  device names (`con`, `prn`, `aux`, `nul`, `com#`, `lpt#`) rejected.

And one subtlety worth keeping: for keys past 200 characters the harness does not trust its own
hash. It scans for any directory sharing the 200-char prefix and confirms by reading each
transcript's recorded `cwd`. A single computed key is not sufficient for very long paths.

Verified on this machine: constructing a path from the computed key **works** (NTFS is
case-insensitive), but comparing the computed key against `readdir` output **fails**, because the
on-disk casing is whichever spelling arrived first. Enumerate and match exact-first with a
case-insensitive fallback — which `agent_transcript.rs` already does.
