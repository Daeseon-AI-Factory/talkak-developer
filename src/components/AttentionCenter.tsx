import { useEffect, useMemo, useRef, useState } from "react";
import { openAttentionRequests } from "../attentionModel";
import type { AttentionRequest, Project, TerminalRuntimeOperation } from "../domain";
import { type Locale, useI18n } from "../i18n";
import { exitWasInterrupted } from "../runtime/exitStatus";
import {
  type RuntimeAttentionKind,
  type RuntimeAttentionNotice,
  isAgentRecordNotice,
} from "../runtime/runtimeAttentionModel";
import { Icon } from "./Icon";

interface AttentionCenterProps {
  requests: readonly AttentionRequest[];
  runtimeNotices: readonly RuntimeAttentionNotice[];
  projects: readonly Project[];
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string | null) => void;
  onResolve: (requestId: string, revision: number, choiceId: string) => boolean;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onOpenRuntimeSession: (projectId: string, sessionId: string) => void;
  onAcknowledgeRuntimeNotice: (notice: RuntimeAttentionNotice) => void;
}

const kindKeys = {
  question: "attention.kind.question",
  approval: "attention.kind.approval",
  result: "attention.kind.result",
  error: "attention.kind.error",
} as const;

const riskKeys = {
  low: "attention.risk.low",
  medium: "attention.risk.medium",
  high: "attention.risk.high",
} as const;

const runtimeOperationKeys: Record<
  TerminalRuntimeOperation,
  | "runtime.operation.availability"
  | "runtime.operation.snapshot"
  | "runtime.operation.start"
  | "runtime.operation.attach"
  | "runtime.operation.read"
  | "runtime.operation.write"
  | "runtime.operation.resize"
  | "runtime.operation.stop"
> = {
  availability: "runtime.operation.availability",
  snapshot: "runtime.operation.snapshot",
  start: "runtime.operation.start",
  attach: "runtime.operation.attach",
  read: "runtime.operation.read",
  write: "runtime.operation.write",
  resize: "runtime.operation.resize",
  stop: "runtime.operation.stop",
};

export function AttentionCenter({
  requests,
  runtimeNotices,
  projects,
  selectedRequestId,
  onSelectRequest,
  onResolve,
  onOpenSession,
  onOpenRuntimeSession,
  onAcknowledgeRuntimeNotice,
}: AttentionCenterProps) {
  const { locale, t, text } = useI18n();
  const [pendingChoice, setPendingChoice] = useState<{
    requestId: string;
    revision: number;
    choiceId: string;
  } | null>(null);
  const [stale, setStale] = useState(false);
  const detailRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const lastRequestIdRef = useRef<string | null>(null);
  const requestButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const openRequests = useMemo(() => openAttentionRequests(requests), [requests]);
  const noticesOf = (kind: RuntimeAttentionKind) =>
    runtimeNotices.filter((notice) => notice.event.kind === kind);
  // Order of urgency: a failing PTY, then an agent that cannot go on without an answer, then
  // decision requests, then processes that ended, then replies waiting to be read.
  const runtimeErrors = noticesOf("error");
  const runtimeNeedsInput = noticesOf("needs-input");
  const runtimeExits = noticesOf("exited");
  const runtimeTurns = noticesOf("turn-complete");
  const urgentRuntime = runtimeErrors[0] ?? runtimeNeedsInput[0] ?? null;
  const selectedRuntimeById = runtimeNotices.find((notice) => notice.id === selectedRequestId);
  const selectedRequestById = requests.find((request) => request.id === selectedRequestId);
  const defaultRuntime =
    urgentRuntime ??
    (openRequests.length === 0 ? (runtimeExits[0] ?? runtimeTurns[0] ?? null) : null);
  const defaultRequest = urgentRuntime === null ? (openRequests[0] ?? null) : null;
  const selectedRuntime =
    selectedRequestId === null ? defaultRuntime : (selectedRuntimeById ?? null);
  const selectedRequest =
    selectedRequestId === null
      ? selectedRuntime
        ? null
        : defaultRequest
      : (selectedRequestById ?? null);
  const exactSelectionExists = Boolean(selectedRuntimeById || selectedRequestById);
  const openCount = openRequests.length + runtimeNotices.length;

  const pendingChoiceId =
    pendingChoice &&
    selectedRequest &&
    pendingChoice.requestId === selectedRequest.id &&
    pendingChoice.revision === selectedRequest.revision
      ? pendingChoice.choiceId
      : null;
  const pendingChoiceValue = selectedRequest?.choices.find(
    (choice) => choice.id === pendingChoiceId,
  );

  useEffect(() => {
    if (selectedRequestId) detailRef.current?.focus();
  }, [selectedRequestId]);

  useEffect(() => {
    if (!selectedRequestId) return;
    const stillExists =
      requests.some((request) => request.id === selectedRequestId) ||
      runtimeNotices.some((notice) => notice.id === selectedRequestId);
    if (!stillExists) onSelectRequest(null);
  }, [onSelectRequest, requests, runtimeNotices, selectedRequestId]);

  function selectRequest(requestId: string) {
    lastRequestIdRef.current = requestId;
    onSelectRequest(requestId);
  }

  function returnToList() {
    const previousRequestId = lastRequestIdRef.current;
    onSelectRequest(null);
    requestAnimationFrame(() => {
      const previousButton = previousRequestId
        ? requestButtonRefs.current.get(previousRequestId)
        : null;
      (previousButton ?? listRef.current)?.focus();
    });
  }

  function acknowledgeRuntimeNotice(notice: RuntimeAttentionNotice) {
    onAcknowledgeRuntimeNotice(notice);
    returnToList();
  }

  function renderRuntimeNotice(notice: RuntimeAttentionNotice) {
    const context = findContext(projects, notice);
    const sessionTitle = context.session ? text(context.session.title) : notice.sessionId;
    return (
      <button
        className="attention-card attention-card--runtime"
        type="button"
        key={notice.id}
        data-testid="runtime-attention-card"
        data-active={notice.id === selectedRuntime?.id}
        data-runtime-kind={notice.event.kind}
        aria-current={notice.id === selectedRuntime?.id ? "true" : undefined}
        ref={(node) => {
          if (node) requestButtonRefs.current.set(notice.id, node);
          else requestButtonRefs.current.delete(notice.id);
        }}
        onClick={() => selectRequest(notice.id)}
      >
        <span className="attention-card__meta">
          <span>{runtimeNoticeKindLabel(notice, t)}</span>
          <span>{context.project?.name ?? notice.projectId}</span>
          <time dateTime={notice.observedAt}>{formatAttentionTime(notice.observedAt, locale)}</time>
        </span>
        <strong>{runtimeNoticeTitle(notice, sessionTitle, t)}</strong>
        <span className="attention-card__description">{runtimeNoticeDescription(notice, t)}</span>
        <span className="attention-card__footer">
          <span>{runtimeNoticeEyebrow(notice, t)}</span>
          <span>{sessionTitle}</span>
        </span>
      </button>
    );
  }

  return (
    <section
      className="attention-center"
      data-detail-open={selectedRequestId !== null && exactSelectionExists}
      aria-labelledby="attention-center-title"
    >
      <header className="attention-center__header">
        <span>{t("attention.centerEyebrow")}</span>
        <h1 id="attention-center-title">{t("attention.centerTitle")}</h1>
        <p>{t("attention.centerDescription")}</p>
        <strong>{t("attention.openCount", { count: openCount })}</strong>
      </header>

      <div className="attention-center__layout">
        <nav
          className="attention-list"
          data-testid="attention-list"
          aria-label={t("attention.listAria")}
          ref={listRef}
          tabIndex={-1}
        >
          {openCount === 0 ? (
            <div className="attention-empty">
              <Icon name="check" size={22} />
              <span>{t("attention.empty")}</span>
            </div>
          ) : null}
          {runtimeErrors.map(renderRuntimeNotice)}
          {runtimeNeedsInput.map(renderRuntimeNotice)}
          {openRequests.map((request) => {
            const context = findContext(projects, request);
            return (
              <button
                className="attention-card"
                type="button"
                key={request.id}
                data-active={request.id === selectedRequest?.id}
                data-risk={request.risk}
                aria-current={request.id === selectedRequest?.id ? "true" : undefined}
                ref={(node) => {
                  if (node) requestButtonRefs.current.set(request.id, node);
                  else requestButtonRefs.current.delete(request.id);
                }}
                onClick={() => selectRequest(request.id)}
              >
                <span className="attention-card__meta">
                  <span>{t(kindKeys[request.kind])}</span>
                  <span>{context.project?.name ?? request.projectId}</span>
                  <time dateTime={request.createdAt}>
                    {formatAttentionTime(request.createdAt, locale)}
                  </time>
                </span>
                <strong>{request.title}</strong>
                <span className="attention-card__description">{request.description}</span>
                <span className="attention-card__footer">
                  <span data-risk={request.risk}>{t(riskKeys[request.risk])}</span>
                  <span>{context.session ? text(context.session.title) : request.sessionId}</span>
                </span>
              </button>
            );
          })}
          {runtimeExits.map(renderRuntimeNotice)}
          {runtimeTurns.map(renderRuntimeNotice)}
        </nav>

        <article
          className="attention-detail"
          aria-label={t("attention.detailAria")}
          ref={detailRef}
          tabIndex={-1}
        >
          {selectedRuntime ? (
            <RuntimeAttentionDetail
              notice={selectedRuntime}
              projects={projects}
              onBack={returnToList}
              // A finished reply or a pending question wants the session itself; a PTY fault
              // wants the raw terminal log.
              onOpenSession={() =>
                (isAgentRecordNotice(selectedRuntime) ? onOpenSession : onOpenRuntimeSession)(
                  selectedRuntime.projectId,
                  selectedRuntime.sessionId,
                )
              }
              onAcknowledge={() => acknowledgeRuntimeNotice(selectedRuntime)}
            />
          ) : selectedRequest ? (
            <AttentionDetail
              request={selectedRequest}
              projects={projects}
              pendingChoiceId={pendingChoiceId}
              pendingChoiceLabel={pendingChoiceValue?.label ?? null}
              stale={stale}
              onBack={returnToList}
              onChoose={(choiceId) => {
                setPendingChoice({
                  requestId: selectedRequest.id,
                  revision: selectedRequest.revision,
                  choiceId,
                });
                setStale(false);
              }}
              onCancel={() => setPendingChoice(null)}
              onConfirm={() => {
                if (!pendingChoiceId) return;
                const resolved = onResolve(
                  selectedRequest.id,
                  selectedRequest.revision,
                  pendingChoiceId,
                );
                if (!resolved) setStale(true);
              }}
              onOpenSession={() =>
                onOpenSession(selectedRequest.projectId, selectedRequest.sessionId)
              }
            />
          ) : (
            <div className="attention-empty attention-empty--detail">
              <Icon name="check" size={25} />
              <span>{t("attention.empty")}</span>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function RuntimeAttentionDetail({
  notice,
  projects,
  onBack,
  onOpenSession,
  onAcknowledge,
}: {
  notice: RuntimeAttentionNotice;
  projects: readonly Project[];
  onBack: () => void;
  onOpenSession: () => void;
  onAcknowledge: () => void;
}) {
  const { t, text } = useI18n();
  const context = findContext(projects, notice);
  const sessionTitle = context.session ? text(context.session.title) : notice.sessionId;
  const agentRecord = isAgentRecordNotice(notice);
  return (
    <>
      <button className="attention-detail__back" type="button" onClick={onBack}>
        <Icon name="arrow-left" size={18} />
        {t("attention.back")}
      </button>
      <div className="attention-detail__meta">
        <span>{runtimeNoticeKindLabel(notice, t)}</span>
        <span>{runtimeNoticeEyebrow(notice, t)}</span>
      </div>
      <p className="attention-detail__context">
        {context.project?.name ?? notice.projectId} / {sessionTitle}
      </p>
      <h2>{runtimeNoticeTitle(notice, sessionTitle, t)}</h2>
      <p className="attention-detail__description">{runtimeNoticeDescription(notice, t)}</p>
      <button
        className="attention-detail__session"
        type="button"
        data-testid={agentRecord ? "open-agent-session" : "open-runtime-terminal"}
        onClick={onOpenSession}
      >
        <Icon name="terminal" size={17} />
        {agentRecord ? t("attention.openSession") : t("attention.openTerminalLog")}
        <Icon name="chevron" size={15} />
      </button>
      <button
        className="attention-detail__acknowledge"
        type="button"
        data-testid="ack-runtime-notice"
        onClick={onAcknowledge}
      >
        <Icon name="check" size={17} />
        {t("attention.runtimeAcknowledge")}
      </button>
      <p className="attention-detail__notice">
        {agentRecord ? t("attention.agentObserved") : t("attention.runtimeObserved")}
      </p>
    </>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function runtimeNoticeKindLabel(notice: RuntimeAttentionNotice, t: Translate): string {
  switch (notice.event.kind) {
    case "error":
      return t("attention.runtimeError");
    case "exited":
      return t("attention.runtimeExited");
    case "needs-input":
      return t("attention.runtimeNeedsInput");
    case "turn-complete":
      return t("attention.runtimeTurnComplete");
  }
}

function runtimeNoticeEyebrow(notice: RuntimeAttentionNotice, t: Translate): string {
  return isAgentRecordNotice(notice) ? t("attention.agentEyebrow") : t("attention.runtimeEyebrow");
}

function runtimeNoticeTitle(
  notice: RuntimeAttentionNotice,
  sessionTitle: string,
  t: Translate,
): string {
  switch (notice.event.kind) {
    case "error":
      return t("attention.runtimeErrorTitle", { session: sessionTitle });
    case "exited":
      return t("attention.runtimeExitedTitle", { session: sessionTitle });
    case "needs-input":
      return t("attention.runtimeNeedsInputTitle", { session: sessionTitle });
    case "turn-complete":
      return t("attention.runtimeTurnCompleteTitle", { session: sessionTitle });
  }
}

function runtimeNoticeDescription(notice: RuntimeAttentionNotice, t: Translate): string {
  const event = notice.event;
  if (event.kind === "error") {
    return event.fault
      ? t("attention.runtimeErrorDescription", {
          operation: t(runtimeOperationKeys[event.fault.operation]),
          message: event.fault.message,
        })
      : t("attention.runtimeUnknownError");
  }
  if (event.kind === "needs-input" || event.kind === "turn-complete") {
    const base =
      event.kind === "needs-input"
        ? t("attention.runtimeNeedsInputDescription")
        : t("attention.runtimeTurnCompleteDescription");
    return event.lastTool
      ? `${base} ${t("attention.runtimeToolSuffix", { tool: event.lastTool })}`
      : base;
  }
  if (exitWasInterrupted(event.exitCode)) {
    return t("attention.runtimeExitedInterrupted");
  }
  return event.exitCode === null
    ? t("attention.runtimeExitedUnknown")
    : t("attention.runtimeExitedCode", { code: event.exitCode });
}

interface AttentionDetailProps {
  request: AttentionRequest;
  projects: readonly Project[];
  pendingChoiceId: string | null;
  pendingChoiceLabel: string | null;
  stale: boolean;
  onBack: () => void;
  onChoose: (choiceId: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenSession: () => void;
}

function AttentionDetail({
  request,
  projects,
  pendingChoiceId,
  pendingChoiceLabel,
  stale,
  onBack,
  onChoose,
  onCancel,
  onConfirm,
  onOpenSession,
}: AttentionDetailProps) {
  const { t, text } = useI18n();
  const context = findContext(projects, request);
  const choicesRef = useRef<HTMLDivElement | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const resolvedRef = useRef<HTMLOutputElement | null>(null);
  const previousChoiceIdRef = useRef<string | null>(pendingChoiceId);

  useEffect(() => {
    if (request.status === "resolved") resolvedRef.current?.focus();
    else if (pendingChoiceId) reviewRef.current?.focus();
    else if (previousChoiceIdRef.current) choicesRef.current?.focus();
    previousChoiceIdRef.current = pendingChoiceId;
  }, [pendingChoiceId, request.status]);

  return (
    <>
      <button className="attention-detail__back" type="button" onClick={onBack}>
        <Icon name="arrow-left" size={18} />
        {t("attention.back")}
      </button>
      <div className="attention-detail__meta">
        <span>{t(kindKeys[request.kind])}</span>
        <span data-risk={request.risk}>{t(riskKeys[request.risk])}</span>
        <span>{t("attention.revision", { revision: request.revision })}</span>
      </div>
      <p className="attention-detail__context">
        {context.project?.name ?? request.projectId} /{" "}
        {context.session ? text(context.session.title) : request.sessionId}
      </p>
      <h2>{request.title}</h2>
      <p className="attention-detail__description">{request.description}</p>
      <button className="attention-detail__session" type="button" onClick={onOpenSession}>
        <Icon name="terminal" size={17} />
        {t("attention.openSession")}
        <Icon name="chevron" size={15} />
      </button>

      {request.status === "resolved" ? (
        <output
          className="attention-state attention-state--resolved"
          ref={resolvedRef}
          tabIndex={-1}
        >
          <Icon name="check" size={18} />
          {t("attention.resolvedPreview")}
        </output>
      ) : (
        <div className="attention-choices" aria-live="polite" ref={choicesRef} tabIndex={-1}>
          <h3>{pendingChoiceId ? t("attention.reviewChoice") : t("attention.choose")}</h3>
          {!pendingChoiceId ? (
            request.choices.length > 0 ? (
              request.choices.map((choice) => (
                <button type="button" key={choice.id} onClick={() => onChoose(choice.id)}>
                  <strong>{choice.label}</strong>
                  {choice.description ? <span>{choice.description}</span> : null}
                </button>
              ))
            ) : (
              <p className="attention-state">{t("attention.noChoices")}</p>
            )
          ) : (
            <div className="attention-review" ref={reviewRef} tabIndex={-1}>
              <strong>{pendingChoiceLabel}</strong>
              <p>{t("attention.localOnly")}</p>
              {stale ? (
                <p className="attention-state attention-state--error">{t("attention.stale")}</p>
              ) : null}
              <div>
                <button type="button" onClick={onCancel}>
                  {t("attention.cancel")}
                </button>
                <button type="button" data-primary="true" onClick={onConfirm}>
                  <Icon name="check" size={17} />
                  {t("attention.confirmPreview")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="attention-detail__notice">{t("attention.localOnly")}</p>
    </>
  );
}

function findContext(
  projects: readonly Project[],
  request: Pick<AttentionRequest, "projectId" | "sessionId">,
) {
  const project = projects.find((candidate) => candidate.id === request.projectId);
  return {
    project,
    session: project?.sessions.find((candidate) => candidate.id === request.sessionId),
  };
}

function formatAttentionTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}
