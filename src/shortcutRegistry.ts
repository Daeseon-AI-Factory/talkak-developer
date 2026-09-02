import type { DesktopPlatform } from "./platform";

export type ShortcutScope = "global" | "workspace";

export type ShortcutCommandId =
  | "palette"
  | "guide"
  | "settings"
  | "toggleSidebar"
  | "newPage"
  | "splitRight"
  | "splitDown"
  | "closePane"
  | "summary"
  | "terminalLog"
  | "previousPage"
  | "nextPage"
  | "previousProject"
  | "nextProject"
  | "previousPane"
  | "nextPane"
  | `focusPane${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "conversation"
  | "scrollMode"
  | "jumpToBottom"
  | `focusProject${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface ShortcutChord {
  code: string;
  keyLabel: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDefinition {
  id: ShortcutCommandId;
  scope: ShortcutScope;
  macos: ShortcutChord;
  windows: ShortcutChord;
  repeat: boolean;
}

export interface ShortcutEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const mac = (code: string, keyLabel: string, options: Partial<ShortcutChord> = {}) => ({
  code,
  keyLabel,
  meta: true,
  ...options,
});

const windows = (code: string, keyLabel: string, options: Partial<ShortcutChord> = {}) => ({
  code,
  keyLabel,
  ctrl: true,
  shift: true,
  ...options,
});

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "palette",
    scope: "global",
    macos: mac("KeyK", "K"),
    windows: windows("KeyK", "K"),
    repeat: false,
  },
  {
    id: "guide",
    scope: "global",
    macos: mac("Slash", "/"),
    windows: windows("Slash", "/"),
    repeat: false,
  },
  {
    id: "settings",
    scope: "global",
    macos: mac("Comma", ","),
    windows: windows("Comma", ","),
    repeat: false,
  },
  {
    id: "toggleSidebar",
    scope: "global",
    macos: mac("KeyB", "B"),
    windows: windows("KeyB", "B"),
    repeat: false,
  },
  {
    id: "newPage",
    scope: "workspace",
    macos: mac("KeyN", "N"),
    windows: windows("KeyN", "N"),
    repeat: false,
  },
  {
    id: "splitRight",
    scope: "workspace",
    macos: mac("KeyD", "D"),
    windows: windows("KeyD", "D"),
    repeat: false,
  },
  {
    id: "splitDown",
    scope: "workspace",
    macos: mac("KeyD", "D", { shift: true }),
    windows: windows("KeyD", "D", { alt: true, shift: false }),
    repeat: false,
  },
  {
    id: "closePane",
    scope: "workspace",
    macos: mac("KeyW", "W"),
    windows: windows("KeyW", "W"),
    repeat: false,
  },
  {
    id: "summary",
    scope: "workspace",
    macos: mac("KeyI", "I"),
    windows: windows("KeyI", "I"),
    repeat: false,
  },
  {
    id: "terminalLog",
    scope: "workspace",
    macos: mac("KeyL", "L"),
    windows: windows("KeyL", "L"),
    repeat: false,
  },
  // One spatial scheme on both platforms: pages are a horizontal row (←/→), projects a vertical
  // list (↑/↓). Windows used PgUp/PgDn here and read as a different product from the macOS build.
  {
    id: "previousPage",
    scope: "workspace",
    macos: mac("ArrowLeft", "←", { alt: true }),
    windows: windows("ArrowLeft", "←"),
    repeat: true,
  },
  {
    id: "nextPage",
    scope: "workspace",
    macos: mac("ArrowRight", "→", { alt: true }),
    windows: windows("ArrowRight", "→"),
    repeat: true,
  },
  {
    // Global, unlike the page/pane cycles: switching project is how you leave any screen.
    // The arrows mirror the sidebar's vertical project list, the way ←/→ mirror the page row.
    id: "previousProject",
    scope: "global",
    macos: mac("ArrowUp", "↑", { alt: true }),
    windows: windows("ArrowUp", "↑"),
    repeat: true,
  },
  {
    id: "nextProject",
    scope: "global",
    macos: mac("ArrowDown", "↓", { alt: true }),
    windows: windows("ArrowDown", "↓"),
    repeat: true,
  },
  {
    id: "previousPane",
    scope: "workspace",
    macos: mac("BracketLeft", "["),
    windows: windows("BracketLeft", "["),
    repeat: true,
  },
  {
    id: "nextPane",
    scope: "workspace",
    macos: mac("BracketRight", "]"),
    windows: windows("BracketRight", "]"),
    repeat: true,
  },
  // Jump to the Nth split of the current page — the original product's number-key navigation.
  // Matching is by event.code, so Shift changing the character on Windows does not matter.
  ...Array.from({ length: 9 }, (_, index) => {
    const digit = index + 1;
    return {
      id: `focusPane${digit}` as ShortcutCommandId,
      scope: "workspace" as ShortcutScope,
      macos: mac(`Digit${digit}`, String(digit)),
      windows: windows(`Digit${digit}`, String(digit)),
      repeat: false,
    };
  }),
  // The agent's conversation log, one chord away from the terminal log it sits beside. Windows
  // takes Alt like splitDown does: Ctrl+Shift+L is already the terminal log there.
  {
    id: "conversation",
    scope: "workspace",
    macos: mac("KeyL", "L", { shift: true }),
    windows: windows("KeyL", "L", { alt: true, shift: false }),
    repeat: false,
  },
  // Reading history while a full-screen program owns the mouse (terminalScrollMode.ts). macOS ⌘↑
  // is free — projects are ⌘⌥↑ there; on Windows Ctrl+Shift+↑ is the project chord, so the page
  // keys carry it instead.
  {
    id: "scrollMode",
    scope: "workspace",
    macos: mac("ArrowUp", "↑"),
    windows: windows("PageUp", "PgUp"),
    repeat: false,
  },
  {
    id: "jumpToBottom",
    scope: "workspace",
    macos: mac("ArrowDown", "↓"),
    windows: windows("PageDown", "PgDn"),
    repeat: false,
  },
  // Jump straight to the Nth project in the sidebar, from any screen — reaching the fourth
  // project took three presses of ↑/↓. The digits are taken by the pane jumps, so this is the
  // next modifier up: ⌘⌥N, and on Windows the same Ctrl+Alt slot splitDown already uses (plain
  // Ctrl stays the terminal's). Ctrl+Alt is AltGr on some non-US Windows layouts, where AltGr+digit
  // types a character; Ctrl+Alt+D accepted that trade-off before this did.
  ...Array.from({ length: 9 }, (_, index) => {
    const digit = index + 1;
    return {
      id: `focusProject${digit}` as ShortcutCommandId,
      scope: "global" as ShortcutScope,
      macos: mac(`Digit${digit}`, String(digit), { alt: true }),
      windows: windows(`Digit${digit}`, String(digit), { alt: true, shift: false }),
      repeat: false,
    };
  }),
] as const;

export function shortcutDefinition(id: ShortcutCommandId): ShortcutDefinition {
  const definition = SHORTCUTS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown shortcut command: ${id}`);
  return definition;
}

export function shortcutChord(platform: DesktopPlatform, id: ShortcutCommandId): ShortcutChord {
  const definition = shortcutDefinition(id);
  return platform === "macos" ? definition.macos : definition.windows;
}

export function shortcutDisplay(platform: DesktopPlatform, id: ShortcutCommandId): string {
  const chord = shortcutChord(platform, id);
  if (platform === "macos") {
    return `${chord.meta ? "⌘" : ""}${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${
      chord.shift ? "⇧" : ""
    }${chord.keyLabel}`;
  }
  return [
    chord.ctrl ? "Ctrl" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    chord.keyLabel,
  ]
    .filter(Boolean)
    .join("+");
}

/**
 * Two related chords as one label. Windows spells its modifiers out, so a naive pair reads
 * "Ctrl+Shift+PgUp · Ctrl+Shift+PgDn" — three times the width of the macOS "⌥← · ⌥→" the page hint
 * was sized around, and it was being cut off mid-word. When both chords share a modifier prefix,
 * say it once.
 */
export function shortcutPairDisplay(
  platform: DesktopPlatform,
  first: ShortcutCommandId,
  second: ShortcutCommandId,
): string {
  const a = shortcutDisplay(platform, first);
  const b = shortcutDisplay(platform, second);
  const cut = a.lastIndexOf("+");
  const prefix = cut > 0 ? a.slice(0, cut + 1) : "";
  if (prefix && b.startsWith(prefix) && b.length > prefix.length) {
    return `${a}/${b.slice(prefix.length)}`;
  }
  return `${a} · ${b}`;
}

export function matchesShortcut(event: ShortcutEvent, chord: ShortcutChord): boolean {
  return (
    event.code === chord.code &&
    event.metaKey === Boolean(chord.meta) &&
    event.ctrlKey === Boolean(chord.ctrl) &&
    event.shiftKey === Boolean(chord.shift) &&
    event.altKey === Boolean(chord.alt)
  );
}

export function commandForShortcut(
  event: ShortcutEvent,
  platform: DesktopPlatform,
  workspaceEnabled: boolean,
): ShortcutDefinition | null {
  return (
    SHORTCUTS.find(
      (definition) =>
        (definition.scope === "global" || workspaceEnabled) &&
        matchesShortcut(event, platform === "macos" ? definition.macos : definition.windows),
    ) ?? null
  );
}
