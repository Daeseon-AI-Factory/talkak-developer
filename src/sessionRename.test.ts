import { describe, expect, it } from "vitest";
import { renamedSessionTitle } from "./sessionRename";

describe("naming a session for the work in it", () => {
  it("keeps what was typed", () => {
    expect(renamedSessionTitle("broker reattach", 2)).toBe("broker reattach");
  });

  it("trims, so a stray space does not become the name", () => {
    expect(renamedSessionTitle("  font pass  ", 2)).toBe("font pass");
  });

  it("returns the generated title when the field is cleared", () => {
    expect(renamedSessionTitle("", 3)).toEqual({ kind: "session-title", index: 3 });
    expect(renamedSessionTitle("   ", 3)).toEqual({ kind: "session-title", index: 3 });
  });
});
