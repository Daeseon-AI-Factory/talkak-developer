import { describe, expect, it } from "vitest";
import { platformFromUserAgent } from "./platform";

describe("platform shortcuts", () => {
  it("detects macOS", () => {
    expect(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });

  it("detects native Windows", () => {
    expect(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  });

  it("keeps unknown user agents explicit", () => {
    expect(platformFromUserAgent("custom-webview")).toBe("other");
  });
});
