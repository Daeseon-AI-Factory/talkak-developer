import { useEffect, useState } from "react";
import type { DevSession } from "../domain";
import { useI18n } from "../i18n";
import { clipboardClient } from "../runtime/clipboardClient";
import {
  type MemoryPage,
  type MemoryRecord,
  handoffDraft,
  memoryClient,
  memoryCopy,
} from "../runtime/memoryClient";
import { errorMessage } from "../runtime/sessionClient";
import { hasAgentConnection, hasMemoryConnection } from "../runtime/sessionLaunch";
import type { AgentTranscript } from "../runtime/transcriptClient";

interface Props {
  projectPath: string;
  session: DevSession;
  transcript: AgentTranscript | null;
}

export function ProjectMemory(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="project-memory" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("memory.title")}</summary>
      {open ? (
        memoryClient.available() ? (
          <MemoryBody key={`${props.projectPath}:${props.session.id}`} {...props} />
        ) : (
          <p>{t("memory.unavailable")}</p>
        )
      ) : null}
    </details>
  );
}

function MemoryBody({ projectPath, session, transcript }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [sourceRef, setSourceRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startupId, setStartupId] = useState("");

  useEffect(() => {
    let current = true;
    memoryClient.search(projectPath, "").then(
      (result) => {
        if (current) setPage(result);
      },
      (cause) => {
        if (current) setError(errorMessage(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [projectPath]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setPage(await memoryClient.search(projectPath, query));
  }

  function draft() {
    const latest = transcript
      ? [...transcript.entries].reverse().find((entry) => entry.role === "assistant")
      : null;
    const text = handoffDraft(latest?.text ?? "");
    setTitle(
      Array.from(text.split("\n")[0] || t("memory.defaultTitle"))
        .slice(0, 120)
        .join(""),
    );
    setBody(text);
    setSourceRef(transcript?.path ?? null);
    setReplacement(null);
    setEditing(true);
    setNotice(null);
  }

  const sourceLabel = (kind: string) =>
    kind === "user"
      ? t("memory.user")
      : kind === "agent"
        ? t("memory.agent")
        : t("memory.imported");

  return (
    <div className="project-memory__body">
      <p className="project-memory__hint">{t("memory.description")}</p>
      <p className="project-memory__hint">
        {hasMemoryConnection(session.launchProfile)
          ? t("memory.connected")
          : hasAgentConnection(session.launchProfile)
            ? t("memory.disabled")
            : t("memory.connectionHint")}
      </p>
      <form
        className="project-memory__search"
        onSubmit={(event) => {
          event.preventDefault();
          void act(refresh);
        }}
      >
        <input
          aria-label={t("memory.search")}
          placeholder={t("memory.searchPlaceholder")}
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <button className="button" type="submit" disabled={busy}>
          {t("memory.search")}
        </button>
      </form>
      <button type="button" className="button" onClick={draft} disabled={busy}>
        {t("memory.draft")}
      </button>
      {editing ? (
        <form
          className="project-memory__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const saved = await memoryClient.save(
                projectPath,
                { title, body, supersedes: replacement },
                {
                  kind: "user",
                  sessionId: session.id,
                  reference: sourceRef,
                },
              );
              setRecord(saved);
              setEditing(false);
              await refresh();
              setNotice(t("memory.saved"));
            });
          }}
        >
          <p className="project-memory__hint">{t("memory.review")}</p>
          <label>
            {t("memory.noteTitle")}
            <input
              required
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            {t("memory.noteBody")}
            <textarea
              required
              value={body}
              rows={7}
              maxLength={1600}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
          </label>
          <div className="project-memory__actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || !body.trim() || !title.trim()}
            >
              {t("memory.save")}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("memory.cancel")}
            </button>
          </div>
        </form>
      ) : null}
      {page?.records.length === 0 ? <p>{t("memory.empty")}</p> : null}
      <ul className="project-memory__list">
        {page?.records.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              disabled={busy}
              data-selected={record?.id === item.id}
              onClick={() =>
                void act(async () => {
                  setRecord(await memoryClient.read(projectPath, item.id));
                })
              }
            >
              <strong>{item.title}</strong>
              <span>{item.excerpt}</span>
              <small>
                {sourceLabel(item.sourceKind)} · {new Date(item.createdAtMs).toLocaleDateString()}
                {page.selectedId === item.id ? ` · ${t("memory.selected")}` : ""}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {page?.hasMore ? <p className="project-memory__hint">{t("memory.more")}</p> : null}
      {page && page.skipped > 0 ? (
        <output>{t("memory.skipped", { count: page.skipped })}</output>
      ) : null}
      {record ? (
        <article className="project-memory__record">
          <strong>{record.title}</strong>
          <p className="project-memory__text">{record.body}</p>
          <small>
            {sourceLabel(record.source.kind)} · {record.id}
          </small>
          <small>
            {t("memory.source")}: {record.source.reference || record.source.sessionId}
          </small>
          <div className="project-memory__actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await clipboardClient.writeText(memoryCopy(record));
                  setNotice(t("memory.copied"));
                })
              }
            >
              {t("memory.copy")}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await memoryClient.select(projectPath, record.id);
                  await refresh();
                  setNotice(t("memory.selectionHint"));
                })
              }
            >
              {t("memory.useNext")}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                setReplacement(record.id);
                setTitle(record.title);
                setBody(record.body);
                setSourceRef(record.source.reference);
                setEditing(true);
              }}
            >
              {t("memory.correct")}
            </button>
          </div>
        </article>
      ) : null}
      {page?.selectedId ? (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await memoryClient.select(projectPath, null);
              await refresh();
            })
          }
        >
          {t("memory.clearSelection")}
        </button>
      ) : null}
      <details className="project-memory__import">
        <summary>{t("memory.import")}</summary>
        <p className="project-memory__hint">{t("memory.importHint")}</p>
        <label>
          {t("memory.startupId")}
          <input
            value={startupId}
            maxLength={100}
            placeholder="startup-…"
            onChange={(event) => setStartupId(event.currentTarget.value)}
          />
        </label>
        <button
          className="button"
          type="button"
          disabled={busy || !startupId.trim()}
          onClick={() =>
            void act(async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const path = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "JSONL", extensions: ["jsonl"] }],
              });
              if (typeof path !== "string") return;
              const report = await memoryClient.import(projectPath, path, startupId.trim());
              await refresh();
              setNotice(
                `${t("memory.importResult", { imported: report.imported, skipped: report.skipped })}${
                  report.correctionsChecked ? "" : ` · ${t("memory.importNoCorrections")}`
                }`,
              );
            })
          }
        >
          {t("memory.chooseImport")}
        </button>
      </details>
      {busy ? <output>{t("memory.working")}</output> : null}
      {notice ? <output>{notice}</output> : null}
      {error ? (
        <p className="project-memory__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
