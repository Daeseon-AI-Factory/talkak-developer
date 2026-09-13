# AGENTS.md — Talkak Dev

Talkak Dev is a small, local-first developer workspace. Keep this repository deliberately
smaller than the product it replaces.

## Product boundary

- The core loop is `Project -> Session -> Result`.
- The first product is for developers managing several projects and agent-backed terminals.
- Talkak is the workspace. Users bring their own agents and credentials.
- A feature is not part of the core unless it improves project switching, terminal work,
  session recovery, summaries, or conversation review.

## Engineering laws

1. **Agent-neutral:** agents, models, endpoints, executable paths, and launch arguments are
   configuration. Never make one provider the product default in code.
2. **Cross-platform:** product code supports Windows and macOS. WSL is a Windows session target,
   not a separate app. Platform-specific code must sit behind a typed adapter with its counterpart
   or an explicit tracked gap.
3. **Clean install:** a packaged app cannot depend on this repository's location, a personal file,
   a global hook, or a manually edited global config.
4. **Local and explicit:** do not install global hooks, mutate shell profiles, or inject prompts
   outside an explicitly configured Talkak session.
5. **Readable source:** keep new source files below 700 lines and split by responsibility.
6. **Honest UI:** mock data and unavailable runtime actions must be visibly labelled.
7. **Bilingual UI:** fixed product copy must go through the typed Korean/English translation layer.
   User-authored prompts, terminal output, and transcripts remain in their original language.

## Stack and boundaries

- Renderer: TypeScript, React, Vite.
- Desktop shell: Tauri 2 with a small Rust command boundary.
- Renderer never reads the filesystem or spawns processes directly.
- Native session work will live behind provider-neutral runtime/session interfaces.

## Verification

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

Passing commands verify their own layer only. Windows packaging and real PTY behavior require
separate platform tests.
