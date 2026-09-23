import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttentionRequest, Project } from "../domain";
import { I18nProvider } from "../i18n";
import type { RuntimeAttentionNotice } from "../runtime/runtimeAttentionModel";
import { createWorkspaceSession } from "../sessionModel";
import { AttentionCenter } from "./AttentionCenter";

const sessions = ["error-session", "request-session", "exit-session"].map((id, index) =>
  createWorkspaceSession({
    id,
    title: `Session ${index + 1}`,
    profile: "Local shell",
    launchProfile: { label: "Local shell", command: null, args: [] },
    branch: "main",
    createdAt: "2026-08-14T01:00:00.000Z",
    lastActivity: "Created",
    intro: null,
    outcome: "",
    nextStep: "",
    launchRequested: false,
  }),
);

const project: Project = {
  id: "project-1",
  source: "local",
  name: "Project",
  monogram: "P",
  color: "#000",
  path: "/project",
  branch: "main",
  description: "",
  launchProfile: { label: "Local shell", command: null, args: [] },
  sessions,
};

const request: AttentionRequest = {
  id: "request-1",
  projectId: project.id,
  sessionId: "request-session",
  kind: "approval",
  risk: "high",
  title: "Approval request",
  description: "Review this decision",
  choices: [],
  createdAt: "2026-08-14T01:01:00.000Z",
  status: "open",
  revision: 1,
  resolution: null,
};

const runtimeNotices: RuntimeAttentionNotice[] = [
  {
    source: "local-pty",
    id: "runtime:error-session:1:error",
    projectId: project.id,
    sessionId: "error-session",
    observedAt: "2026-08-14T01:02:00.000Z",
    event: { kind: "error", fault: { operation: "read", message: "stream closed" } },
  },
  {
    source: "local-pty",
    id: "runtime:exit-session:1:exited",
    projectId: project.id,
    sessionId: "exit-session",
    observedAt: "2026-08-14T01:03:00.000Z",
    event: { kind: "exited", exitCode: 7 },
  },
];

describe("AttentionCenter", () => {
  it("orders PTY errors before decisions and normal exits, with the error selected", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AttentionCenter
          requests={[request]}
          runtimeNotices={runtimeNotices}
          projects={[project]}
          selectedRequestId={null}
          onSelectRequest={() => {}}
          onResolve={() => false}
          onOpenSession={() => {}}
          onOpenRuntimeSession={() => {}}
          onAcknowledgeRuntimeNotice={() => {}}
        />
      </I18nProvider>,
    );

    const errorIndex = markup.indexOf('data-runtime-kind="error"');
    const requestIndex = markup.indexOf("Approval request");
    const exitIndex = markup.indexOf('data-runtime-kind="exited"');

    expect(errorIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeLessThan(requestIndex);
    expect(requestIndex).toBeLessThan(exitIndex);
    expect(markup.slice(errorIndex, requestIndex)).toContain('aria-current="true"');
  });

  it("does not jump to another detail while a stale selected ID is being cleared", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AttentionCenter
          requests={[request]}
          runtimeNotices={runtimeNotices}
          projects={[project]}
          selectedRequestId="missing-notice"
          onSelectRequest={() => {}}
          onResolve={() => false}
          onOpenSession={() => {}}
          onOpenRuntimeSession={() => {}}
          onAcknowledgeRuntimeNotice={() => {}}
        />
      </I18nProvider>,
    );
    const detail = markup.slice(markup.indexOf('<article class="attention-detail"'));

    expect(markup).toContain('data-detail-open="false"');
    expect(detail).not.toContain("stream closed");
  });
});

const agentNotices: RuntimeAttentionNotice[] = [
  {
    source: "local-pty",
    id: "runtime:request-session:2:turn-complete",
    projectId: project.id,
    sessionId: "request-session",
    observedAt: "2026-08-14T01:04:00.000Z",
    event: { kind: "turn-complete", lastTool: "Edit" },
  },
  {
    source: "local-pty",
    id: "runtime:exit-session:3:needs-input",
    projectId: project.id,
    sessionId: "exit-session",
    observedAt: "2026-08-14T01:05:00.000Z",
    event: { kind: "needs-input", lastTool: null },
  },
];

describe("AttentionCenter agent record notices", () => {
  it("lists a blocked agent right after PTY errors and a finished turn last", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AttentionCenter
          requests={[request]}
          runtimeNotices={[...runtimeNotices, ...agentNotices]}
          projects={[project]}
          selectedRequestId={null}
          onSelectRequest={() => {}}
          onResolve={() => false}
          onOpenSession={() => {}}
          onOpenRuntimeSession={() => {}}
          onAcknowledgeRuntimeNotice={() => {}}
        />
      </I18nProvider>,
    );

    const order = ["error", "needs-input", "exited", "turn-complete"].map((kind) =>
      markup.indexOf(`data-runtime-kind="${kind}"`),
    );
    const requestIndex = markup.indexOf("Approval request");
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(requestIndex);
    expect(requestIndex).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(markup).toContain("Edit");
  });

  it("opens the session itself for an agent notice, and names the record as the source", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AttentionCenter
          requests={[]}
          runtimeNotices={agentNotices}
          projects={[project]}
          selectedRequestId="runtime:exit-session:3:needs-input"
          onSelectRequest={() => {}}
          onResolve={() => false}
          onOpenSession={() => {}}
          onOpenRuntimeSession={() => {}}
          onAcknowledgeRuntimeNotice={() => {}}
        />
      </I18nProvider>,
    );
    const detail = markup.slice(markup.indexOf('<article class="attention-detail"'));

    expect(detail).toContain('data-testid="open-agent-session"');
    expect(detail).not.toContain('data-testid="open-runtime-terminal"');
    expect(detail).toContain('data-testid="ack-runtime-notice"');
  });
});
