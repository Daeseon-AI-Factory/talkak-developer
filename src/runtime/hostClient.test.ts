import { describe, expect, it } from "vitest";
import { type HostInfo, normalizeOpenSourceLocationFailure, windowsPtyOption } from "./hostClient";

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

describe("opening a source location, what went wrong", () => {
  it("passes through a typed failure the Rust command rejected with", () => {
    expect(
      normalizeOpenSourceLocationFailure({ kind: "outsideWorkspace", detail: "/etc/passwd" }),
    ).toEqual({ kind: "outsideWorkspace", detail: "/etc/passwd" });
  });

  it("defaults a missing detail to an empty string rather than 'undefined'", () => {
    expect(normalizeOpenSourceLocationFailure({ kind: "editorNotFound" })).toEqual({
      kind: "editorNotFound",
      detail: "",
    });
  });

  it("falls back to openFailed for a kind the Rust side never sends", () => {
    expect(normalizeOpenSourceLocationFailure({ kind: "somethingNew", detail: "x" }).kind).toBe(
      "openFailed",
    );
  });

  it("falls back to openFailed for a transport error with no kind at all", () => {
    expect(normalizeOpenSourceLocationFailure(new Error("broker gone"))).toEqual({
      kind: "openFailed",
      detail: "broker gone",
    });
  });
});
