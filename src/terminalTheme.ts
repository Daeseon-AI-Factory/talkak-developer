import type { ITheme } from "@xterm/xterm";

/**
 * One terminal appearance for every xterm surface. The live pane and the read-only log show the
 * same PTY bytes, so they must resolve to the same font and the same palette on the same machine.
 */

// Mirrors --mono in styles/foundation.css. JetBrains Mono draws the Latin and D2Coding the Hangul,
// both bundled, so a pane looks identical on macOS and Windows. The system names are a safety net.
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", D2Coding, ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Apple SD Gothic Neo", "Malgun Gothic", monospace';

// xterm's stock palette is built for pure black. Naming all sixteen keeps coloured CLI output
// legible against this background instead of muddy.
export const TERMINAL_THEME: ITheme = {
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
};
