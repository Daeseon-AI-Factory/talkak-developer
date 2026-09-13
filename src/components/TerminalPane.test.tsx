import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivity, DevSession, TerminalRuntimeStatus } from "../domain";
import { I18nProvider } from "../i18n";
import { createWorkspaceSession } from "../sessionModel";
import { TerminalPane } from "./TerminalPane";

vi.mock("./SessionTerminal", () => ({
  SessionTerminal: ({ session }: { session: DevSession }) => (
    <div data-session-terminal={session.id} />
  ),
}));

function status(overrides: Partial<TerminalRuntimeStatus> = {}): TerminalRuntimeStatus {
  return {
    phase: "running",
    runId: 2,
    exitCode: null,
    termination: null,
    fault: null,
    observedAt: "2026-09-01T01:00:00.000Z",
    ...overrides,
  };
}

function session(
  runtimeStatus: TerminalRuntimeStatus | null,
  agentActivity: AgentActivity | null,
  state: DevSession["state"] = "idle",
): DevSession {
  return {
    ...createWorkspaceSession({
      id: "session-1",
      title: "Session",
      profile: "Agent",
      launchProfile: { label: "Agent", command: "agent", args: [] },
      branch: "main",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActivity: "Created",
      intro: null,
      outcome: "",
      nextStep: "",
      launchRequested: false,
    }),
    runtimeStatus,
    agentActivity,
    state,
  };
}

function render(value: DevSession): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TerminalPane
        paneId="pane-1"
        session={value}
        projectPath="/project"
        active={false}
        canMove={false}
        canSplit={false}
        onFocus={() => {}}
        onOpenConversation={() => {}}
        onSplit={() => {}}
        onMove={() => {}}
        onDetach={() => {}}
        onLaunchHandled={() => {}}
        onRename={() => {}}
        onRuntimeObservation={() => {}}
      />
    </I18nProvider>,
  );
}

function statusLine(markup: string): string {
  const start = markup.indexOf('data-testid="pane-status"');
  const open = markup.indexOf(">", start);
  return markup.slice(open + 1, markup.indexOf("</span>", open));
}

describe("TerminalPane status line", () => {
  it("says what the agent is doing while the PTY is live, tool included", () => {
    const working = session(status(), { state: "working", lastTool: "Bash", at: null }, "working");
    const markup = render(working);
    expect(statusLine(markup)).toBe("Bash 실행 중");
    expect(markup).toContain('data-agent-activity="working"');
    expect(markup).toContain('data-state="working"');

    expect(
      statusLine(render(session(status(), { state: "done", lastTool: null, at: null }, "ready"))),
    ).toBe("응답 완료");
    expect(
      statusLine(
        render(
          session(status(), { state: "needs-input", lastTool: null, at: null }, "needs-input"),
        ),
      ),
    ).toBe("입력 대기");
  });

  it("falls back to the PTY phase when the record says nothing yet", () => {
    expect(statusLine(render(session(status(), null)))).toBe("실행 중");
    expect(statusLine(render(session(status(), { state: "idle", lastTool: null, at: null })))).toBe(
      "실행 중",
    );
  });

  it("lets a dead PTY override the record — the process is the fact", () => {
    const exited = status({ phase: "exited", exitCode: 0, termination: "observed-exit" });
    const markup = render(session(exited, { state: "working", lastTool: "Edit", at: null }));
    expect(statusLine(markup)).not.toContain("Edit");
    expect(markup).not.toContain("data-agent-activity=");
  });

  it("labels a long-quiet mid-turn record as a hint that the agent may be gone", () => {
    const longAgo = new Date(Date.now() - 25 * 60_000).toISOString();
    const markup = render(
      session(status(), { state: "thinking", lastTool: null, at: longAgo }, "working"),
    );
    expect(statusLine(markup)).toContain("에이전트가 종료됐을 수 있음");
    expect(statusLine(markup)).toContain("25분");
  });

  it("does not call a finished turn stale, however long it waits", () => {
    const longAgo = new Date(Date.now() - 180 * 60_000).toISOString();
    const markup = render(
      session(status(), { state: "done", lastTool: null, at: longAgo }, "ready"),
    );
    expect(statusLine(markup)).toBe("응답 완료");
  });
});
