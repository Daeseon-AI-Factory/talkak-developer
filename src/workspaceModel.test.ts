import { describe, expect, it } from "vitest";
import { projects } from "./demo";
import { countSessions, firstSession, runtimeLabel } from "./workspaceModel";

describe("workspace model", () => {
  it("counts only actionable session states", () => {
    expect(countSessions(projects[0].sessions)).toEqual({
      working: 1,
      needsInput: 1,
      ready: 0,
    });
  });

  it("keeps WSL as a Windows session target", () => {
    const wslSession = projects[1].sessions[0];
    if (wslSession.runtime.kind !== "wsl") throw new Error("Expected the fixture to use WSL");
    expect(wslSession.runtime.os).toBe("windows");
    expect(runtimeLabel(wslSession)).toBe("WSL · Ubuntu");
  });

  it("provides an explicit empty fallback", () => {
    expect(firstSession({ ...projects[0], sessions: [] })).toBeNull();
  });
});
