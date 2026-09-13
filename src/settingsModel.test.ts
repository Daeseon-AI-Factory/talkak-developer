import { describe, expect, it } from "vitest";
import {
  createDefaultSettingsState,
  effectiveSetting,
  featureSettingIds,
  setSettingOverride,
} from "./settingsModel";

describe("settings model", () => {
  it("keeps every optional feature disabled by default", () => {
    const state = createDefaultSettingsState();

    expect(
      featureSettingIds.map((id) =>
        effectiveSetting(state, id, {
          projectId: "project-a",
          sessionId: "session-a",
        }),
      ),
    ).toEqual(featureSettingIds.map(() => false));
  });

  it("falls back from session to project to app", () => {
    let state = createDefaultSettingsState();
    state = setSettingOverride(state, "app", null, "voiceInput", true);
    state = setSettingOverride(state, "project", "project-a", "voiceInput", false);
    state = setSettingOverride(state, "session", "session-a", "voiceInput", true);

    expect(effectiveSetting(state, "voiceInput")).toBe(true);
    expect(effectiveSetting(state, "voiceInput", { projectId: "project-a" })).toBe(false);
    expect(
      effectiveSetting(state, "voiceInput", {
        projectId: "project-a",
        sessionId: "session-a",
      }),
    ).toBe(true);
    expect(
      effectiveSetting(state, "voiceInput", {
        projectId: "project-a",
        sessionId: "session-b",
      }),
    ).toBe(false);
    expect(
      effectiveSetting(state, "voiceInput", {
        projectId: "project-b",
        sessionId: "session-b",
      }),
    ).toBe(true);
  });

  it("removes an override to restore its parent fallback", () => {
    let state = createDefaultSettingsState();
    state = setSettingOverride(state, "app", null, "notifications", true);
    state = setSettingOverride(state, "project", "project-a", "notifications", false);
    state = setSettingOverride(state, "project", "project-a", "notifications", null);

    expect(effectiveSetting(state, "notifications", { projectId: "project-a" })).toBe(true);
    expect(state.projects["project-a"]).toBeUndefined();
  });

  it("updates immutably and rejects mismatched scope targets", () => {
    const initial = createDefaultSettingsState();
    const next = setSettingOverride(initial, "session", "session-a", "remoteAccess", true);

    expect(next).not.toBe(initial);
    expect(initial.sessions).toEqual({});
    expect(next.sessions["session-a"]).toEqual({ remoteAccess: true });
    expect(() => setSettingOverride(next, "app", "project-a", "remoteAccess", true)).toThrow(
      RangeError,
    );
    expect(() => setSettingOverride(next, "project", null, "remoteAccess", true)).toThrow(
      RangeError,
    );
  });
});
