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
- session summary and conversation-log inspector
- adaptive phone, tablet, and desktop presentations backed by the same session state
- a phone session view with conversation, terminal, summary, and unsent draft review
- optional app/project/session settings whose default is off
- native macOS / native Windows / Windows WSL runtime target model
- a provider-neutral native PTY boundary for spawn, write, read, resize, snapshot, and kill
- an ANSI terminal loaded on demand only after a desktop session starts

The Tauri desktop app can start the operating system's default shell in an explicit absolute working
directory. Executables and arguments remain runtime configuration; no agent is hardcoded as the
product default. Output replay is memory-bounded and process state is currently in-memory only.
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
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Windows execution and packaging must be checked on Windows CI or a Windows machine. WSL is modeled
as a per-session runtime target launched by the Windows app, never as a separate Talkak build.
