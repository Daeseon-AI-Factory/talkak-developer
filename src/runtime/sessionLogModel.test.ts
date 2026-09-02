import { describe, expect, it } from "vitest";
import { initialSessionLogCursor, sessionLogResumePoint } from "./sessionLogModel";

describe("session log resume point", () => {
  it("starts a never-opened log at the beginning of the current run", () => {
    expect(sessionLogResumePoint(initialSessionLogCursor, 4)).toEqual({ after: 0, reset: false });
  });

  it("continues from the retained cursor for the same run", () => {
    expect(sessionLogResumePoint({ runId: 4, after: 3 }, 4)).toEqual({ after: 3, reset: false });
  });

  it("keeps the retained cursor when the current run is not yet known", () => {
    expect(sessionLogResumePoint({ runId: 4, after: 3 }, null)).toEqual({
      after: 3,
      reset: false,
    });
  });

  it("clears the emulator and replays from zero when the session started a new run", () => {
    expect(sessionLogResumePoint({ runId: 7, after: 900 }, 8)).toEqual({ after: 0, reset: true });
  });
});
