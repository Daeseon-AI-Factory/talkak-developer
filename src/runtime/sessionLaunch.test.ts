import { describe, expect, it } from "vitest";
import { createSessionSpawnInput } from "./sessionLaunch";

describe("session launch", () => {
  it("passes a configured executable and exact argument array to PTY spawn", () => {
    expect(
      createSessionSpawnInput("session-1", " C:\\work\\app ", {
        label: "Review",
        command: " agent-cli ",
        args: ["--mode", "review target"],
      }),
    ).toEqual({
      sessionId: "session-1",
      cwd: "C:\\work\\app",
      command: "agent-cli",
      args: ["--mode", "review target"],
      cols: 80,
      rows: 24,
    });
  });

  it("uses the OS default terminal and drops arguments when no command is configured", () => {
    expect(
      createSessionSpawnInput("session-2", "", {
        label: "",
        command: null,
        args: ["must-not-leak"],
      }),
    ).toEqual({
      sessionId: "session-2",
      cwd: null,
      command: null,
      args: [],
      cols: 80,
      rows: 24,
    });
  });
});
