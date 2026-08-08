import { describe, expect, it } from "vitest";
import { platformFromUserAgent, shortcutLabel } from "./platform";

describe("platform shortcuts", () => {
  it("uses Command on macOS", () => {
    const platform = platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(platform).toBe("macos");
    expect(shortcutLabel(platform, "k")).toBe("⌘ K");
  });

  it("uses Control in the native Windows app", () => {
    const platform = platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(platform).toBe("windows");
    expect(shortcutLabel(platform, "k")).toBe("Ctrl K");
  });

  it("uses Control for non-macOS fallbacks", () => {
    expect(shortcutLabel("other", "k")).toBe("Ctrl K");
  });
});
