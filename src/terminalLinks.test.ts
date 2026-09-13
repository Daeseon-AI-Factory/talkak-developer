import type { ILink, ILinkProvider } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import type { SourceLocation } from "./sourceLocations";
import {
  type SourceLinkLine,
  type SourceLinkTerminal,
  attachSourceLinks,
  coloredRuns,
  lineTextWithColumns,
  sourceOpenFailureKey,
} from "./terminalLinks";

/** A buffer row from a string: every character one cell, except the ones listed as wide. */
function row(text: string, wide = ""): SourceLinkLine {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of text) {
    if (wide.includes(char)) {
      cells.push({ chars: char, width: 2 }, { chars: "", width: 0 });
    } else {
      cells.push({ chars: char, width: 1 });
    }
  }
  return {
    getCell: (x) => {
      const cell = cells[x];
      return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
    },
  };
}

function terminalWith(lines: SourceLinkLine[], cols = 80) {
  let provider: ILinkProvider | undefined;
  let disposed = false;
  const terminal: SourceLinkTerminal = {
    cols,
    buffer: { active: { getLine: (y) => lines[y] } },
    registerLinkProvider: (candidate) => {
      provider = candidate;
      return {
        dispose: () => {
          disposed = true;
        },
      };
    },
  };
  const linksOn = (y: number) =>
    new Promise<ILink[] | undefined>((resolve) => provider?.provideLinks(y, resolve));
  return { terminal, linksOn, wasDisposed: () => disposed };
}

describe("terminal source links", () => {
  it("underlines a path:line span at its exact columns and activates with its location", async () => {
    const activated: Array<[SourceLocation, string]> = [];
    const { terminal, linksOn } = terminalWith([row("error at src/app.ts:12:5 in build")]);
    attachSourceLinks(terminal, (location, text) => activated.push([location, text]));

    const links = await linksOn(1);
    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe("src/app.ts:12:5");
    expect(links?.[0].range).toEqual({ start: { x: 10, y: 1 }, end: { x: 24, y: 1 } });
    expect(links?.[0].decorations).toEqual({ pointerCursor: true, underline: true });

    links?.[0].activate(new Event("click") as MouseEvent, "src/app.ts:12:5");
    expect(activated).toEqual([[{ path: "src/app.ts", line: 12, column: 5 }, "src/app.ts:12:5"]]);
  });

  it("keeps the range in cells when a wide glyph precedes the path", async () => {
    // "파일" is two wide glyphs: four cells but two code units. Measured in string offsets, the link
    // would start two cells early and underline the space and the first letters of the word before.
    const { terminal, linksOn } = terminalWith([row("파일 src/a.ts:3", "파일")]);
    attachSourceLinks(terminal, () => undefined);
    const links = await linksOn(1);
    expect(links?.[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 15, y: 1 } });
  });

  it("offers nothing on a row without a reference or past the buffer", async () => {
    const { terminal, linksOn } = terminalWith([row("just prose")]);
    attachSourceLinks(terminal, () => undefined);
    expect(await linksOn(1)).toBeUndefined();
    expect(await linksOn(2)).toBeUndefined();
  });

  it("registers one provider and disposes it through the returned handle", () => {
    const { terminal, wasDisposed } = terminalWith([]);
    const links = attachSourceLinks(terminal, () => undefined);
    expect(wasDisposed()).toBe(false);
    links.dispose();
    expect(wasDisposed()).toBe(true);
  });
});

describe("row text with columns", () => {
  it("maps every code unit back to the cell it was read from", () => {
    const { text, columns } = lineTextWithColumns(row("a한b", "한"), 80);
    expect(text).toBe("a한b");
    expect(columns).toEqual([0, 1, 3]);
  });

  it("renders an empty cell as a space so offsets stay aligned", () => {
    const line: SourceLinkLine = {
      getCell: (x) =>
        x < 3 ? { getChars: () => (x === 1 ? "" : "x"), getWidth: () => 1 } : undefined,
    };
    expect(lineTextWithColumns(line, 80).text).toBe("x x");
  });
});

describe("failure messages", () => {
  it("maps every host reason to a translated key", () => {
    expect(sourceOpenFailureKey({ kind: "notFound", detail: "" })).toBe("terminal.sourceNotFound");
    expect(sourceOpenFailureKey({ kind: "outsideWorkspace", detail: "" })).toBe(
      "terminal.sourceOutsideWorkspace",
    );
    expect(sourceOpenFailureKey({ kind: "editorNotFound", detail: "" })).toBe(
      "terminal.sourceEditorNotFound",
    );
    expect(sourceOpenFailureKey({ kind: "unavailable", detail: "" })).toBe(
      "terminal.sourceDesktopOnly",
    );
    expect(sourceOpenFailureKey({ kind: "openFailed", detail: "" })).toBe(
      "terminal.sourceOpenFailed",
    );
  });
});

describe("coloredRuns", () => {
  const row = (cells: { chars: string; colored: boolean; width?: number }[]) => ({
    getCell: (x: number) => {
      const cell = cells[x];
      return cell
        ? {
            getChars: () => cell.chars,
            getWidth: () => cell.width ?? 1,
            isFgDefault: () => !cell.colored,
          }
        : undefined;
    },
  });
  const chars = (text: string, colored: boolean) => [...text].map((c) => ({ chars: c, colored }));

  it("keeps interior single spaces inside one colored run and splits on default text", () => {
    const line = row([
      ...chars("ps aux", true),
      ...chars(" ", true),
      ...chars("| grep node", true),
      ...chars("  ", false),
      ...chars("plain", false),
      ...chars(" ", false),
      ...chars("abc123", true),
    ]);
    expect(coloredRuns(line, 40)).toEqual([
      { text: "ps aux | grep node", start: 0, end: 17 },
      { text: "abc123", start: 26, end: 31 },
    ]);
  });

  it("skips one-character runs, runs without letters or digits, and box-drawing frames", () => {
    const line = row([
      ...chars("x", true),
      ...chars(" ", false),
      ...chars("──", true),
      ...chars(" ", false),
      ...chars("── ok ─", true),
      ...chars(" ", false),
      ...chars("!!", true),
    ]);
    expect(coloredRuns(line, 40)).toEqual([]);
  });

  it("uses cell columns, so a wide glyph before a run does not shift it", () => {
    const line = row([
      { chars: "한", colored: false, width: 2 },
      { chars: "", colored: false, width: 0 },
      ...chars("ls", true),
    ]);
    expect(coloredRuns(line, 10)).toEqual([{ text: "ls", start: 2, end: 3 }]);
  });
});
