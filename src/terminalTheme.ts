import type { ITheme } from "@xterm/xterm";
import { useSyncExternalStore } from "react";

/**
 * One terminal appearance for every xterm surface. The live pane and the read-only log show the
 * same PTY bytes, so they must resolve to the same font and the same palette on the same machine.
 *
 * The palette is a preset the user picks. The choice lives in this browser's storage only — it is
 * a look, not project state — and applies live: subscribers repaint every retained emulator.
 */

// Mirrors --mono in styles/foundation.css. JetBrains Mono draws the Latin and D2Coding the Hangul,
// both bundled, so a pane looks identical on macOS and Windows. The system names are a safety net.
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", D2Coding, ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Apple SD Gothic Neo", "Malgun Gothic", monospace';

export interface TerminalThemePreset {
  id: string;
  /** A proper name, the same in both languages. */
  name: string;
  /** The contrast floor xterm enforces for text against the background; 1 leaves colours alone. */
  minimumContrastRatio: number;
  theme: ITheme;
}

export const DEFAULT_TERMINAL_THEME_ID = "talkak";

export const TERMINAL_THEME_PRESETS: readonly TerminalThemePreset[] = [
  {
    id: DEFAULT_TERMINAL_THEME_ID,
    name: "Talkak",
    minimumContrastRatio: 1,
    // xterm's stock palette is built for pure black. Naming all sixteen keeps coloured CLI output
    // legible against this background instead of muddy.
    theme: {
      background: "#071216",
      foreground: "#c4dadd",
      cursor: "#86f3f7",
      selectionBackground: "#23454d",
      black: "#0b1a1f",
      red: "#ff6b81",
      green: "#5bd6a0",
      yellow: "#e8c56a",
      blue: "#6aa9f7",
      magenta: "#c58cf5",
      cyan: "#5bd2dd",
      white: "#c4dadd",
      brightBlack: "#4a6670",
      brightRed: "#ff8fa0",
      brightGreen: "#7ee7ba",
      brightYellow: "#f5da8c",
      brightBlue: "#8ec2ff",
      brightMagenta: "#d9acff",
      brightCyan: "#86f3f7",
      brightWhite: "#eaf6f8",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    minimumContrastRatio: 4,
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#7f848e",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    minimumContrastRatio: 4,
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#8a8fb0",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    minimumContrastRatio: 4,
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#8b95a7",
      brightRed: "#d0868e",
      brightGreen: "#b9d3a3",
      brightYellow: "#f2d9a8",
      brightBlue: "#9bb8d3",
      brightMagenta: "#c9a8c4",
      brightCyan: "#a3d2df",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    minimumContrastRatio: 3,
    theme: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#657b83",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
];

const STORAGE_KEY = "talkak.terminalTheme";

export function terminalThemePreset(id: string | null | undefined): TerminalThemePreset {
  return TERMINAL_THEME_PRESETS.find((preset) => preset.id === id) ?? TERMINAL_THEME_PRESETS[0];
}

function readStoredThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TERMINAL_THEME_ID;
  } catch {
    return DEFAULT_TERMINAL_THEME_ID;
  }
}

let active: TerminalThemePreset | null = null;
const listeners = new Set<(preset: TerminalThemePreset) => void>();

export function activeTerminalTheme(): TerminalThemePreset {
  if (!active) active = terminalThemePreset(readStoredThemeId());
  return active;
}

export function activeTerminalThemeId(): string {
  return activeTerminalTheme().id;
}

/** Persist the choice and tell every subscriber; an unknown id falls back to the default. */
export function setActiveTerminalThemeId(id: string): TerminalThemePreset {
  const preset = terminalThemePreset(id);
  active = preset;
  try {
    localStorage.setItem(STORAGE_KEY, preset.id);
  } catch {
    // The look still changes for this run when storage is unavailable.
  }
  for (const listener of listeners) listener(preset);
  return preset;
}

export function subscribeTerminalTheme(
  listener: (preset: TerminalThemePreset) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active preset as React state: re-renders when the choice changes. */
export function useTerminalTheme(): TerminalThemePreset {
  return useSyncExternalStore(subscribeTerminalTheme, activeTerminalTheme, activeTerminalTheme);
}

/** Test seam: forget the cached choice so the next read consults storage again. */
export function resetTerminalThemeCache(): void {
  active = null;
}
