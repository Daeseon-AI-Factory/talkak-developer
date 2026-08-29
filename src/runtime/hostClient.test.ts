import { describe, expect, it } from "vitest";
import { type HostInfo, windowsPtyOption } from "./hostClient";

const host = (patch: Partial<HostInfo>): HostInfo => ({
  os: "windows",
  architecture: "x86_64",
  supportsWslDiscovery: true,
  windowsBuild: 26200,
  ...patch,
});

describe("telling xterm what pty it is driving", () => {
  it("describes a ConPTY on Windows, with the build the host reported", () => {
    expect(windowsPtyOption(host({}))).toEqual({
      windowsPty: { backend: "conpty", buildNumber: 26200 },
    });
  });

  it("says nothing on macOS, where the option would be a lie", () => {
    expect(windowsPtyOption(host({ os: "macos", windowsBuild: null }))).toEqual({});
  });

  it("says nothing rather than guessing when the build is unknown", () => {
    // A wrong build number selects the wrong buffer heuristics, which is worse than none.
    expect(windowsPtyOption(host({ windowsBuild: null }))).toEqual({});
  });

  it("says nothing in the browser preview, where there is no host to ask", () => {
    expect(windowsPtyOption(null)).toEqual({});
  });
});
