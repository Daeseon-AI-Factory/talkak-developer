import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import type { AgentTranscript, TranscriptEntry } from "../runtime/transcriptClient";
import type { TranscriptState } from "../runtime/useAgentTranscript";
import { createWorkspaceSession } from "../sessionModel";
import { ConversationView } from "./ConversationView";

function session() {
  return createWorkspaceSession({
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
}

function transcript(entries: TranscriptEntry[]): AgentTranscript {
  return {
    source: "agent",
    path: "record.jsonl",
    entries,
    totalEntries: entries.length,
    changedFiles: [],
    lastActivity: null,
    revision: 1,
    activity: { state: "idle", lastTool: null, at: null },
    usage: null,
  };
}

function render(state: TranscriptState, preview = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConversationView
        session={session()}
        state={state}
        preview={preview}
        className="conversation-list"
        showMeta
      />
    </I18nProvider>,
  );
}

const dayAgo = (days: number, hour = 9) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

describe("ConversationView", () => {
  it("renders the record's markdown as structure, not as raw syntax", () => {
    const markup = render({
      kind: "loaded",
      transcript: transcript([
        {
          role: "assistant",
          text: "Use **bold** and `pnpm test`.\n\n```sh\npnpm build\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
          at: null,
          tools: [],
          decisions: [],
        },
      ]),
    });

    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).not.toContain("**bold**");
    expect(markup).toContain('class="conversation-inline-code"');
    expect(markup).toMatch(/<code role="button"[^>]*>pnpm test<\/code>/);
    expect(markup).toContain('class="conversation-code"');
    expect(markup).toContain("코드 복사");
    expect(markup).toContain("<table>");
    expect(markup).toContain("메시지 복사");
  });

  it("names the tools a turn ran and the choice the user made", () => {
    const markup = render({
      kind: "loaded",
      transcript: transcript([
        {
          role: "assistant",
          text: "Which one?",
          at: null,
          tools: ["Read", "Read", "Bash"],
          decisions: [
            { question: "Deploy target?", options: ["staging", "prod"], selected: "prod" },
          ],
        },
        {
          role: "assistant",
          text: "",
          at: null,
          tools: ["Edit"],
          decisions: [{ question: "Continue?", options: ["yes", "no"], selected: null }],
        },
      ]),
    });

    expect(markup).toContain("도구 · Read ×2 · Bash");
    expect(markup).toContain("도구 · Edit");
    expect(markup).toContain("Deploy target?");
    expect(markup).toMatch(/data-selected="true"><span>prod<\/span><em>선택<\/em>/);
    expect(markup).toMatch(/data-selected="false"><span>staging<\/span>/);
    expect(markup).toContain("선택 기록 없음");
    // A turn with no text has nothing to copy, so no copy button.
    expect(markup.match(/class="conversation-copy"[^>]*aria-label="메시지 복사"/g)).toHaveLength(1);
  });

  it("separates days with Today and Yesterday, once per day", () => {
    const markup = render({
      kind: "loaded",
      transcript: transcript([
        { role: "user", text: "one", at: dayAgo(1, 8), tools: [], decisions: [] },
        { role: "assistant", text: "two", at: dayAgo(1, 9), tools: [], decisions: [] },
        { role: "user", text: "three", at: dayAgo(0, 8), tools: [], decisions: [] },
        { role: "assistant", text: "four", at: null, tools: [], decisions: [] },
      ]),
    });

    const separators = markup.match(/class="conversation-day">([^<]+)</g) ?? [];
    expect(separators).toEqual([
      'class="conversation-day">어제<',
      'class="conversation-day">오늘<',
    ]);
    expect(markup.match(/class="conversation-entry"/g)).toHaveLength(4);
  });

  it("keeps the five honesty states distinct from an empty list", () => {
    expect(render({ kind: "loading" })).toContain("에이전트 기록을 읽는 중");
    expect(render({ kind: "absent" })).toContain("이 세션에 연결된 에이전트 기록이 없습니다.");
    expect(render({ kind: "unsupported" })).toContain("브라우저 미리보기에서는");
    expect(render({ kind: "failed", message: "EACCES" })).toContain(
      "기록을 읽지 못했습니다 — EACCES",
    );
    expect(render({ kind: "loaded", transcript: transcript([]) })).toContain(
      "아직 기록된 대화가 없습니다.",
    );
  });
});
