import { describe, expect, it } from "vitest";
import { preservedScrollLine } from "./terminalFit";

describe("scroll position across a reflow", () => {
  it("leaves a reader who is at the bottom at the bottom", () => {
    // viewportY === baseY means the live region is on screen: new output belongs there.
    expect(preservedScrollLine(400, 400, 380)).toBeNull();
  });

  it("keeps the same distance from the bottom when reflow moves baseY", () => {
    // Scrolled up 100 lines; rewrapping grew the buffer to 460 — stay 100 from the bottom.
    expect(preservedScrollLine(400, 300, 460)).toBe(360);
  });

  it("keeps the distance when reflow shrinks the buffer", () => {
    expect(preservedScrollLine(400, 300, 350)).toBe(250);
  });

  it("leaves the viewport alone when the old position no longer exists", () => {
    // Clamping to 0 here yanked the pane to the very top of its scrollback — the last place the
    // reader was looking. Better to leave the viewport where the reflow put it.
    expect(preservedScrollLine(400, 100, 120)).toBeNull();
    expect(preservedScrollLine(400, 100, 300)).toBeNull();
  });

  it("treats an over-scrolled viewport as being at the bottom", () => {
    expect(preservedScrollLine(400, 401, 380)).toBeNull();
  });
});
