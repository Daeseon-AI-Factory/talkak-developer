import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DevSession } from "../domain";
import { I18nProvider } from "../i18n";
import { createWorkspaceSession } from "../sessionModel";
import { Inspector } from "./Inspector";

vi.mock("./TerminalLogView", () => ({
  TerminalLogView: ({
    sessionId,
    currentRunId,
  }: {
    sessionId: string;
    currentRunId?: number | null;
  }) => (
    <div data-terminal-log-session={sessionId} data-terminal-log-run={currentRunId ?? "none"} />
  ),
}));

function session(): DevSession {
  return createWorkspaceSession({
    id: "session-1",
    title: "Session",
    profile: "Agent",
    launchProfile: { label: "Agent", command: "codex", args: [] },
    branch: "main",
    createdAt: "2026-08-31T12:00:00.000Z",
    lastActivity: "FAKE ACTIVITY",
    intro: null,
    outcome: "FAKE OUTCOME",
    nextStep: "FAKE NEXT STEP",
    launchRequested: false,
  });
}

function render(
  sessionValue: DevSession,
  source: "local" | "preview",
  mode: "summary" | "conversation" | "terminal",
) {
  return renderToStaticMarkup(
    <I18nProvider>
      <Inspector
        session={sessionValue}
        projectPath="C:\\project"
        projectSource={source}
        mode={mode}
        pinned
        onChangeMode={() => {}}
        onTogglePin={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
}

describe("Inspector transcript views", () => {
  it("does not present seeded summary fields as facts for a local session", () => {
    const current = session();
    current.summary.decisions.push("FAKE DECISION");

    const markup = render(current, "local", "summary");

    expect(markup).not.toContain("FAKE OUTCOME");
    expect(markup).not.toContain("FAKE NEXT STEP");
    expect(markup).not.toContain("FAKE DECISION");
    expect(markup).not.toContain("progress-track");
    expect(markup).toContain("로컬 세션 기록");
  });

  it("keeps seeded data visible only when it is labelled as preview data", () => {
    const markup = render(session(), "preview", "summary");

    expect(markup).toContain("예시 데이터");
    expect(markup).toContain("FAKE OUTCOME");
    expect(markup).toContain("FAKE NEXT STEP");
  });

  it("mounts only the newest 60 conversation turns before the user asks for older turns", () => {
    const current = session();
    current.conversation = Array.from({ length: 200 }, (_, index) => ({
      id: `turn-${index}`,
      author: index % 2 === 0 ? "you" : "agent",
      time: "12:00",
      text: `message ${index}`,
    }));

    const markup = render(current, "preview", "conversation");

    expect(markup).not.toContain("message 139<");
    expect(markup).toContain("message 140");
    expect(markup).toContain("message 199");
    expect(markup).toContain("이전 80턴 보기");
    expect(markup.match(/class="conversation-entry"/g)).toHaveLength(60);
  });

  it("passes the observed run id to restart a drained terminal log reader", () => {
    const current = session();
    current.runtimeStatus = {
      phase: "running",
      runId: 42,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: "2026-08-31T12:01:00.000Z",
    };

    const markup = render(current, "local", "terminal");

    expect(markup).toContain('data-terminal-log-session="session-1"');
    expect(markup).toContain('data-terminal-log-run="42"');
  });
});
