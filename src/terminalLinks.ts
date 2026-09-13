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

/** The cell slice the colored-run provider reads; xterm's IBufferCell satisfies it. */
export interface CopyRunCell extends SourceLinkCell {
  isFgDefault(): number | boolean;
}

export interface CopyRunLine {
  getCell(x: number): CopyRunCell | undefined;
}

export interface CopyRunTerminal {
  cols: number;
  buffer: { active: { getLine(y: number): CopyRunLine | undefined } };
  registerLinkProvider(provider: ILinkProvider): IDisposable;
}

export interface CopyRun {
  text: string;
  /** 0-based first and last cell columns. */
  start: number;
  end: number;
}

const BOX_GLYPH = /[\u2500-\u259F]/;

/**
 * Contiguous runs of non-default-foreground text on a row. Programs (and agents) color the thing
 * you would want to copy — a command in a cheatsheet, a path, a hash — so each run becomes a
 * click-to-copy link. Interior single spaces stay inside a run so `ps aux | grep node` is one
 * link; runs shorter than two characters, without a letter or digit, or carrying box-drawing
 * glyphs (TUI frames and separators) are not links. Heuristic, as in the original product.
 */
export function coloredRuns(line: CopyRunLine, cols: number): CopyRun[] {
  const runs: CopyRun[] = [];
  let start = -1;
  let end = -1;
  let text = "";
  let gap = "";
  const flush = () => {
    const trimmed = text.trim();
    if (
      start >= 0 &&
      trimmed.length >= 2 &&
      /[A-Za-z0-9]/.test(trimmed) &&
      !BOX_GLYPH.test(trimmed)
    ) {
      runs.push({ text: trimmed, start, end });
    }
    start = -1;
    end = -1;
    text = "";
    gap = "";
  };
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    const isSpace = chars === "" || chars === " ";
    if (!isSpace && !cell.isFgDefault()) {
      if (start < 0) start = x;
      text += gap + chars;
      gap = "";
      end = x;
    } else if (isSpace && start >= 0) {
      gap += " ";
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/**
 * Registered ONCE per emulator like the source links. Rows that carry a `path:line` reference
 * are left to that provider so one span never has two competing links.
 */
export function attachCopyRunLinks(
  terminal: CopyRunTerminal,
  onCopy: (text: string) => void,
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const { text } = lineTextWithColumns(line, terminal.cols);
      if (extractSourceLocationMatches(text).length > 0) {
        callback(undefined);
        return;
      }
      const links = coloredRuns(line, terminal.cols).map<ILink>((run) => ({
        text: run.text,
        range: {
          start: { x: run.start + 1, y: bufferLineNumber },
          end: { x: run.end + 1, y: bufferLineNumber },
        },
        decorations: { pointerCursor: true, underline: true },
        activate: () => onCopy(run.text),
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
