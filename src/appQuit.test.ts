import { describe, expect, it } from "vitest";
import { runningSessionKills } from "./appQuit";
import type { Project } from "./domain";

const project = (sessions: Project["sessions"]): Project => ({ id: "p", sessions }) as Project;

const session = (
  id: string,
  status: { phase: string; runId: number | null } | undefined,
): Project["sessions"][number] =>
  ({
    id,
    runtimeStatus: status ? { ...status, exitCode: null, termination: null, fault: null } : null,
  }) as unknown as Project["sessions"][number];

describe("quit dialog targets", () => {
  it("collects exactly the sessions whose child may still be alive", () => {
    const kills = runningSessionKills([
      project([
        session("a", { phase: "running", runId: 3 }),
        session("b", { phase: "exited", runId: 2 }),
        session("c", { phase: "starting", runId: 5 }),
        session("d", { phase: "stopping", runId: 7 }),
        session("e", undefined),
        session("f", { phase: "running", runId: null }),
      ]),
    ]);
    expect(kills).toEqual([
      { sessionId: "a", runId: 3 },
      { sessionId: "c", runId: 5 },
      { sessionId: "d", runId: 7 },
    ]);
  });

  it("reports nothing for an idle workspace, so the window closes without asking", () => {
    expect(runningSessionKills([project([session("a", { phase: "idle", runId: null })])])).toEqual(
      [],
    );
  });
});
