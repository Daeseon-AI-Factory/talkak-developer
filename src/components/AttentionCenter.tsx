import { useEffect, useMemo, useRef, useState } from "react";
import { openAttentionRequests } from "../attentionModel";
import type { AttentionRequest, Project } from "../domain";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

interface AttentionCenterProps {
  requests: readonly AttentionRequest[];
  projects: readonly Project[];
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string | null) => void;
  onResolve: (requestId: string, revision: number, choiceId: string) => boolean;
  onOpenSession: (projectId: string, sessionId: string) => void;
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

export function AttentionCenter({
  requests,
  projects,
  selectedRequestId,
  onSelectRequest,
  onResolve,
  onOpenSession,
}: AttentionCenterProps) {
  const { t, text } = useI18n();
  const [pendingChoice, setPendingChoice] = useState<{
    requestId: string;
    revision: number;
    choiceId: string;
  } | null>(null);
  const [stale, setStale] = useState(false);
  const detailRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastRequestIdRef = useRef<string | null>(null);
  const requestButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const openRequests = useMemo(() => openAttentionRequests(requests), [requests]);
  const selectedRequest =
    requests.find((request) => request.id === selectedRequestId) ?? openRequests[0] ?? null;

  const pendingChoiceId =
    pendingChoice?.requestId === selectedRequest?.id &&
    pendingChoice.revision === selectedRequest.revision
      ? pendingChoice.choiceId
      : null;
  const pendingChoiceValue = selectedRequest?.choices.find(
    (choice) => choice.id === pendingChoiceId,
  );

  useEffect(() => {
    if (selectedRequestId) detailRef.current?.focus();
  }, [selectedRequestId]);

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

  return (
    <section
      className="attention-center"
      data-detail-open={Boolean(selectedRequestId)}
      aria-labelledby="attention-center-title"
    >
      <header className="attention-center__header">
        <span>{t("attention.centerEyebrow")}</span>
        <h1 id="attention-center-title">{t("attention.centerTitle")}</h1>
        <p>{t("attention.centerDescription")}</p>
        <strong>{t("attention.openCount", { count: openRequests.length })}</strong>
      </header>

      <div className="attention-center__layout">
        <div
          className="attention-list"
          aria-label={t("attention.listAria")}
          ref={listRef}
          tabIndex={-1}
        >
          {openRequests.length === 0 ? (
            <div className="attention-empty">
              <Icon name="check" size={22} />
              <span>{t("attention.empty")}</span>
            </div>
          ) : null}
          {openRequests.map((request) => {
            const context = findContext(projects, request);
            return (
              <button
                className="attention-card"
                type="button"
                key={request.id}
                data-active={request.id === selectedRequest?.id}
                data-risk={request.risk}
                ref={(node) => {
                  if (node) requestButtonRefs.current.set(request.id, node);
                  else requestButtonRefs.current.delete(request.id);
                }}
                onClick={() => selectRequest(request.id)}
              >
                <span className="attention-card__meta">
                  <span>{t(kindKeys[request.kind])}</span>
                  <span>{context.project?.name ?? request.projectId}</span>
                  <time>{request.createdAt}</time>
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
        </div>

        <article
          className="attention-detail"
          aria-label={t("attention.detailAria")}
          ref={detailRef}
          tabIndex={-1}
        >
          {selectedRequest ? (
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

function findContext(projects: readonly Project[], request: AttentionRequest) {
  const project = projects.find((candidate) => candidate.id === request.projectId);
  return {
    project,
    session: project?.sessions.find((candidate) => candidate.id === request.sessionId),
  };
}
