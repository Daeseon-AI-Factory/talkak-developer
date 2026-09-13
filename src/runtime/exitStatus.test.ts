import { describe, expect, it } from "vitest";
import { WINDOWS_CONTROL_C_EXIT, exitWasInterrupted } from "./exitStatus";

describe("exit status presentation", () => {
  it("recognises Windows console interruption without changing ordinary exit codes", () => {
    expect(exitWasInterrupted(WINDOWS_CONTROL_C_EXIT)).toBe(true);
    expect(exitWasInterrupted(7)).toBe(false);
    expect(exitWasInterrupted(null)).toBe(false);
  });
});
