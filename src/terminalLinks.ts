import type { IDisposable, ILink, ILinkProvider } from "@xterm/xterm";
import type { MessageKey } from "./i18n/strings";
import type { OpenSourceLocationFailure } from "./runtime/hostClient";
import { type SourceLocation, extractSourceLocationMatches } from "./sourceLocations";

/**
 * `path:line` references in a terminal become links. Registered ONCE per emulator: terminals are
 * retained across page switches, and xterm stacks providers, so registering per mount would
 * underline the same span N times and fire N activations. The disposer lives with the retained
 * entry and is called by releaseTerminal.
 *
 * The provider is agent-neutral by construction — it reads cells, not any program's output format.
 */

/** The slice of an xterm buffer cell this reads; a test hands in plain objects. */
export interface SourceLinkCell {
  getChars(): string;
  getWidth(): number;
}

export interface SourceLinkLine {
  getCell(x: number): SourceLinkCell | undefined;
}

export interface SourceLinkTerminal {
  cols: number;
  buffer: { active: { getLine(y: number): SourceLinkLine | undefined } };
  registerLinkProvider(provider: ILinkProvider): IDisposable;
}

/**
 * A buffer row as text, plus the cell column each UTF-16 unit came from. A wide glyph (Hangul,
 * CJK, emoji) takes two cells but one or two code units, so string offsets and columns drift
 * apart after it; the link range must be in columns or it lands beside the path.
 */
export function lineTextWithColumns(
  line: SourceLinkLine,
  cols: number,
): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    // The trailing half of a wide glyph holds no character of its own.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let unit = 0; unit < chars.length; unit += 1) columns.push(x);
    text += chars;
  }
  return { text, columns };
}

export function attachSourceLinks(
  terminal: SourceLinkTerminal,
  onActivate: (location: SourceLocation, text: string) => void,
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const { text, columns } = lineTextWithColumns(line, terminal.cols);
      const links = extractSourceLocationMatches(text).map<ILink>((match) => ({
        text: match.text,
        // xterm ranges are 1-based and inclusive at both ends.
        range: {
          start: { x: columns[match.start] + 1, y: bufferLineNumber },
          end: { x: columns[match.end - 1] + 1, y: bufferLineNumber },
        },
        decorations: { pointerCursor: true, underline: true },
        activate: (_event, activated) => onActivate(match.location, activated),
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });
}

/** The message to show when opening a reference failed, by the host's typed reason. */
export function sourceOpenFailureKey(failure: OpenSourceLocationFailure): MessageKey {
  switch (failure.kind) {
    case "notFound":
      return "terminal.sourceNotFound";
    case "notAFile":
      return "terminal.sourceNotAFile";
    case "outsideWorkspace":
      return "terminal.sourceOutsideWorkspace";
    case "editorNotFound":
      return "terminal.sourceEditorNotFound";
    case "editorFailed":
      return "terminal.sourceEditorFailed";
    case "unavailable":
      return "terminal.sourceDesktopOnly";
    default:
      return "terminal.sourceOpenFailed";
  }
}
