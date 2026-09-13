import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DevSession, Project, TerminalRuntimeStatus } from "../domain";
import { I18nProvider } from "../i18n";
import { createWorkspaceSession } from "../sessionModel";
import { MobileSessionView } from "./MobileSessionView";

vi.mock("./TerminalLogView", () => ({
  TerminalLogView: () => <div data-terminal-log />,
}));

const running: TerminalRuntimeStatus = {
  phase: "running",
  runId: 7,
  exitCode: null,
  termination: null,
  fault: null,
  observedAt: "2026-09-01T00:00:00.000Z",
};

function session(runtimeStatus: TerminalRuntimeStatus | null): DevSession {
  const value = createWorkspaceSession({
    id: "session-1",
    title: "Session",
    profile: "Agent",
    launchProfile: { label: "Agent", command: "agent", args: [] },
    branch: "main",
    createdAt: "2026-08-31T12:00:00.000Z",
    lastActivity: "FAKE ACTIVITY",
    intro: null,
    outcome: "FAKE OUTCOME",
    nextStep: "FAKE NEXT STEP",
    launchRequested: false,
  });
  value.runtimeStatus = runtimeStatus;
  return value;
}

function project(source: Project["source"], current: DevSession): Project {
  return {
    id: "project-1",
    source,
    name: "Project",
    monogram: "P",
    color: "#000",
    path: "C:\\project",
    branch: "main",
    description: "",
    launchProfile: { label: "Agent", command: "agent", args: [] },
    sessions: [current],
  };
}

function render(source: Project["source"], runtimeStatus: TerminalRuntimeStatus | null) {
  const current = session(runtimeStatus);
  return renderToStaticMarkup(
    <I18nProvider>
      <MobileSessionView
        project={project(source, current)}
        session={current}
        draft="continue"
        activeTab="summary"
        reviewedDraft="continue"
        voiceEnabled={false}
        onDraftChange={() => {}}
        onSelectSession={() => {}}
        onSelectTab={() => {}}
        onReviewDraft={() => {}}
        onEditDraft={() => {}}
        onOpenSettings={() => {}}
      />
    </I18nProvider>,
  );
}

function sendButton(markup: string): string {
  const match = markup.match(/<button[^>]*class="mobile-draft-review__send"[^>]*>[^<]*<\/button>/);
  if (!match) throw new Error("no send button in markup");
  return match[0];
}

describe("MobileSessionView composer", () => {
  it("offers Send only while the session's PTY is running", () => {
    const button = sendButton(render("local", running));

    expect(button).not.toContain("disabled");
    expect(button).toContain("세션에 전송");
  });

  it("says why it cannot send when the session is not running", () => {
    const exited = sendButton(render("local", { ...running, phase: "exited", exitCode: 0 }));
    expect(exited).toContain("disabled");
    expect(exited).toContain("세션이 실행 중이 아니라 전송할 수 없습니다");

    const noRun = sendButton(render("local", null));
    expect(noRun).toContain("disabled");
  });

  it("never sends into an example project", () => {
    const button = sendButton(render("preview", running));

    expect(button).toContain("disabled");
    expect(button).toContain("예시 프로젝트에는 전송할 수 없습니다");
  });

  it("keeps a reviewed draft labelled as not sent until it is", () => {
    expect(render("local", running)).toContain("아직 전송되지 않은 로컬 초안입니다.");
  });
});
