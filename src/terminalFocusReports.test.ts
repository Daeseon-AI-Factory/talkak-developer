import { describe, expect, it } from "vitest";
import { FOCUS_REPORT_STRIPPING_ENABLED, stripFocusReports } from "./terminalFocusReports";

describe("focus report stripping", () => {
  it("removes CSI I and CSI O and nothing else", () => {
    expect(stripFocusReports("[I")).toBe("");
    expect(stripFocusReports("[O")).toBe("");
    expect(stripFocusReports("[Ipnpm test[O")).toBe("pnpm test");
    // Arrow keys, and every other CSI, pass through untouched.
    expect(stripFocusReports("[A[1;5C")).toBe("[A[1;5C");
    expect(stripFocusReports("")).toBe("");
  });

  it("stays switched off until the symptom is reproduced in this app", () => {
    expect(FOCUS_REPORT_STRIPPING_ENABLED).toBe(false);
  });
});
