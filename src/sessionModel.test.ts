import { describe, expect, it } from "vitest";
import { createWorkspaceSession } from "./sessionModel";

describe("workspace sessions", () => {
  it("copies launch arguments and keeps launch intent explicit", () => {
    const args = ["--review"];
    const session = createWorkspaceSession({
      id: "session-1",
      title: "Session 1",
      profile: "Local shell",
      launchProfile: { label: "Local shell", command: "agent", args },
      branch: "feature/review",
      createdAt: "2026-08-09T00:00:00.000Z",
      lastActivity: "Created now",
      intro: "Ready",
      outcome: "Start work",
      nextStep: "Use the terminal",
      launchRequested: true,
    });

    args.push("--mutated");
    expect(session.launchProfile.args).toEqual(["--review"]);
    expect(session.branch).toBe("feature/review");
    expect(session.launchRequested).toBe(true);
    expect(session.lines[0]?.text).toBe("Ready");
  });
});
