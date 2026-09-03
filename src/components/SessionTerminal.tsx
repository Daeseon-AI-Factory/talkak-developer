import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type {
  DevSession,
  LaunchProfile,
  TerminalRuntimeObservation,
  TerminalRuntimeObservationOrigin,
  TerminalRuntimeOperation,
  TerminalRuntimePhase,
  TerminalRuntimeStatus,
} from "../domain";
import { useI18n } from "../i18n";
import { projectClient } from "../runtime/projectClient";
import {
  createRuntimeOperationTracker,
  invalidateRuntimeOperations,
} from "../runtime/runtimeOperationGuard";
import {
  type SessionSubscription,
  ensureSessionStarted,
  errorMessage,
  sessionClient,
} from "../runtime/sessionClient";
import { createSessionSpawnInput } from "../runtime/sessionLaunch";
import type { TerminalOutputWriter } from "../runtime/terminalOutputWriter";
import { terminalRuntimePhase, terminalStreamEnabled } from "../runtime/terminalReplay";
import { createTerminalStreamConsumer } from "../runtime/terminalStream";
import { shouldApplyRuntimeObservation } from "../sessionRuntimeState";
import {
  releaseTerminal,
  resetRetainedRun,
  retainedTerminal,
  updateRetainedCursor,
} from "../terminalInstances";
import { releaseDetachedTerminalLog } from "../terminalLogInstances";
import {
  type PendingTerminalOutput,
  canMoveTerminalFocus,
  useTerminalPaneRuntime,
} from "../terminalPaneRuntime";
import { ConfirmDialog } from "./ConfirmDialog";
import { Toast } from "./Toast";

interface ObservedRuntimeCursor {
  runId: number;
  next: number;
}

const observedRuntimeCursors = new Map<string, ObservedRuntimeCursor>();

interface SessionTerminalProps {
  session: DevSession;
  projectPath: string;
  focused: boolean;
  background?: boolean;
  onRuntimeAttached: (attached: boolean) => void;
  onLaunchHandled: (sessionId: string) => void;
  onRuntimeObservation: (sessionId: string, observation: TerminalRuntimeObservation) => void;
}

export function SessionTerminal({
  session,
  projectPath,
  focused,
  background = false,
  onRuntimeAttached,
  onLaunchHandled,
  onRuntimeObservation,
}: SessionTerminalProps) {
  const { locale, runtimePhaseLabel, t, text } = useI18n();
  const launchCommand = session.launchProfile.command?.trim() || null;
  const launchLabel = session.launchProfile.label || t("terminal.defaultShell");
  const [phase, setPhase] = useState<TerminalRuntimePhase>("checking");
  const [cwd, setCwd] = useState(projectPath);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [restartReady, setRestartReady] = useState(false);
  // A saved profile can name an executable that no longer resolves. Knowing that before the user
  // presses anything is what keeps this launcher down to one honest button.
  const [commandMissing, setCommandMissing] = useState(false);
  // Stopping kills the session's whole process tree — an agent mid-task included — so the button
  // asks first.
  const [confirmStop, setConfirmStop] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const cursorRef = useRef(0);
  const replayThroughRef = useRef(0);
  const pendingOutputRef = useRef<PendingTerminalOutput[]>([]);
  const outputWriterRef = useRef<TerminalOutputWriter | null>(null);
  const terminalAttachFailedRef = useRef(false);
  const focusedRef = useRef(focused);
  const launchRequestedRef = useRef(session.launchRequested === true);
  const launchHandledRef = useRef(onLaunchHandled);
  const runtimeObservationRef = useRef(onRuntimeObservation);
  const runtimeStatusRef = useRef<TerminalRuntimeStatus | null>(session.runtimeStatus ?? null);
  const runtimeOperationsRef = useRef(createRuntimeOperationTracker());
  const storedRuntimeStatusRef = useRef(session.runtimeStatus);
  // Read by the pane runtime hook only when a `path:line` link is activated, so the working
  // directory field can change on every keystroke without retriggering the terminal mount effect.
  const cwdRef = useRef(cwd);
  const projectRootRef = useRef(projectPath);
  focusedRef.current = focused;
  launchRequestedRef.current = session.launchRequested === true;
  launchHandledRef.current = onLaunchHandled;
  runtimeObservationRef.current = onRuntimeObservation;
  storedRuntimeStatusRef.current = session.runtimeStatus;
  cwdRef.current = cwd;
  projectRootRef.current = projectPath;

  useEffect(() => {
    if (!launchCommand || !projectClient.available()) {
      setCommandMissing(false);
      return;
    }
    let cancelled = false;
    void projectClient
      .validateCommand(launchCommand)
      .then((result) => {
        if (!cancelled) setCommandMissing(!result.valid);
      })
      // A failed check must not accuse a working profile; the spawn itself stays the real answer.
      .catch(() => {
        if (!cancelled) setCommandMissing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [launchCommand]);

  const terminalAttached = phase === "running" || phase === "stopping" || phase === "exited";
  const shouldAttachTerminal = background
    ? phase === "running" || phase === "stopping"
    : terminalAttached;

  useEffect(() => onRuntimeAttached(terminalAttached), [onRuntimeAttached, terminalAttached]);

  useEffect(() => {
    const shouldLaunch = launchRequestedRef.current;
    const snapshotEpoch = advanceRuntimeEpoch();
    let cancelled = false;
    const storedStatus = storedRuntimeStatusRef.current ?? null;
    runtimeStatusRef.current = storedStatus;
    setCwd(projectPath);
    setPhase(storedStatus?.phase ?? "checking");
    setError(storedStatus?.fault?.message ?? null);
    setExitCode(storedStatus?.exitCode ?? null);
    setRestartReady(false);
    // Restore the retained cursor HERE, synchronously: the output stream opens before any async
    // attach work resolves, and a stream opened at cursor 0 replays the whole buffer into an
    // emulator that already shows it — the exact crawl retention exists to remove.
    cursorRef.current = retainedTerminal(session.id)?.cursor ?? 0;
    replayThroughRef.current = 0;
    if (!sessionClient.available()) {
      reportRuntimeStatus("passive-probe", emptyRuntimeStatus("unavailable"));
      if (shouldLaunch) launchHandledRef.current(session.id);
      return () => {
        cancelled = true;
        advanceRuntimeEpoch();
      };
    }

    if (shouldLaunch) {
      reportRuntimeStatus("explicit-action", emptyRuntimeStatus("starting"));
    }
    const request = createSessionSpawnInput(session.id, projectPath, session.launchProfile);
    const snapshot = shouldLaunch
      ? ensureSessionStarted(request)
      : sessionClient.snapshot(session.id);
    void snapshot
      .then((snapshot) => {
        if (cancelled || runtimeOperationsRef.current.epoch !== snapshotEpoch) return;
        if (!snapshot) {
          observedRuntimeCursors.delete(session.id);
          releaseTerminal(session.id);
          // The session is gone from the broker; nothing should keep parsing its old log either.
          releaseDetachedTerminalLog(session.id);
          reportRuntimeStatus("passive-probe", emptyRuntimeStatus("idle"));
          return;
        }
        // A retained buffer from another run must not sit under this one: drop it and rewind, so
        // the new run paints from its own byte zero into a fresh emulator.
        const kept = retainedTerminal(session.id);
        if (kept && kept.runId !== null && kept.runId !== snapshot.runId) {
          releaseTerminal(session.id);
          releaseDetachedTerminalLog(session.id);
          cursorRef.current = 0;
        }
        prepareRuntimeReplay(session.id, snapshot.runId, snapshot.next);
        setRestartReady(!snapshot.running && snapshot.readClosed);
        const previous = currentRuntimeStatus("checking");
        const sameRun = previous.runId === snapshot.runId;
        const nextPhase = terminalRuntimePhase(
          sameRun ? previous.phase : "checking",
          snapshot.running,
          snapshot.readError,
        );
        reportRuntimeStatus(shouldLaunch ? "runtime-event" : "passive-probe", {
          phase: nextPhase,
          runId: snapshot.runId,
          exitCode: snapshot.exitCode,
          termination:
            nextPhase === "exited"
              ? sameRun
                ? (previous.termination ?? "observed-exit")
                : "observed-exit"
              : nextPhase === "stopping"
                ? "requested-stop"
                : null,
          fault: snapshot.readError
            ? { operation: "read", message: snapshot.readError }
            : sameRun
              ? previous.fault
              : null,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled || runtimeOperationsRef.current.epoch !== snapshotEpoch) return;
        reportRuntimeFault(shouldLaunch ? "start" : "snapshot", cause, "error");
      })
      .finally(() => {
        if (shouldLaunch && !cancelled) launchHandledRef.current(session.id);
      });
    return () => {
      cancelled = true;
      advanceRuntimeEpoch();
    };
  }, [projectPath, session.id, session.launchProfile]);

  const { toast, scrollActive, viewport, jumpToBottom, toggleScrollMode, releaseMouse } =
    useTerminalPaneRuntime({
      sessionId: session.id,
      shouldAttachTerminal,
      locale,
      hostRef,
      terminalRef,
      pendingOutputRef,
      outputWriterRef,
      terminalAttachFailedRef,
      focusedRef,
      cwdRef,
      projectRootRef,
      runtimeStatusRef,
      runtimeOperationsRef,
      reportRuntimeFault,
      clearRuntimeFault,
      setError,
    });

  useEffect(() => {
    if (!focused || !terminalAttached) return;
    if (!canMoveTerminalFocus()) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focused, terminalAttached]);

  useEffect(() => {
    if (!focused || !terminalAttached) return;
    const restoreFocus = () => {
      if (canMoveTerminalFocus()) terminalRef.current?.focus();
    };
    window.addEventListener("focus", restoreFocus);
    return () => window.removeEventListener("focus", restoreFocus);
  }, [focused, terminalAttached]);

  useEffect(() => {
    if (!terminalStreamEnabled(phase, background)) return;
    let cancelled = false;
    let subscription: SessionSubscription | null = null;
    const streamEpoch = runtimeOperationsRef.current.epoch;
    const streamIsCurrent = () => !cancelled && runtimeOperationsRef.current.epoch === streamEpoch;

    const consumer = createTerminalStreamConsumer({
      commit: async ({ runId, next, bytes, suppressProtocolInput }) => {
        if (runtimeStatusRef.current?.runId !== runId) return false;
        // Bytes the emulator already holds are skipped, not repainted. A stream is opened at the
        // cursor known when the effect ran, and a write submitted by the previous mount can still
        // land after that and move the cursor past the stream's start.
        const alreadyIn = Math.max(0, cursorRef.current - (next - bytes.length));
        const fresh = alreadyIn >= bytes.length ? new Uint8Array(0) : bytes.subarray(alreadyIn);
        if (fresh.length > 0 && !(await writeOutput(fresh, suppressProtocolInput))) return false;
        return recordReadCursor(runId, Math.max(next, cursorRef.current));
      },
      truncatedMarker: () => new TextEncoder().encode(`\r\n${t("terminal.historyTruncated")}\r\n`),
      replayThrough: (frame) =>
        frame.running ? replayThroughRef.current : Number.POSITIVE_INFINITY,
      status: (frame) => {
        if (!streamIsCurrent()) return;
        setRestartReady(!frame.running && frame.readClosed);
        const previous = currentRuntimeStatus(phase);
        const fault = frame.error
          ? { operation: "read" as const, message: frame.error }
          : previous.fault?.operation === "read"
            ? null
            : previous.fault;
        const nextPhase = terminalRuntimePhase(previous.phase, frame.running, frame.error);
        reportRuntimeStatus("runtime-event", {
          phase: nextPhase,
          runId: frame.runId,
          exitCode: frame.exitCode,
          termination: !frame.running
            ? (previous.termination ?? "observed-exit")
            : nextPhase === "stopping"
              ? "requested-stop"
              : null,
          fault,
        });
      },
    });

    syncObservedReadCursor();
    void sessionClient
      .attach(session.id, cursorRef.current, (frame) => {
        if (!streamIsCurrent()) return;
        if (frame.runId === 0 && frame.ended) {
          // The stream itself failed — broker gone, session vanished — so there is no run to
          // commit against; the pane shows the transport's reason instead of going quiet.
          reportRuntimeFault("read", new Error(frame.error ?? "session stream ended"), "error");
          return;
        }
        void consumer.push(frame);
      })
      .then((opened) => {
        if (streamIsCurrent()) {
          subscription = opened;
        } else {
          void opened.detach();
        }
      })
      .catch((cause: unknown) => {
        if (streamIsCurrent()) reportRuntimeFault("read", cause, "error");
      });

    return () => {
      cancelled = true;
      consumer.stop();
      if (subscription) void subscription.detach();
    };
  }, [background, phase, session.id, t]);

  function prepareRuntimeReplay(sessionId: string, runId: number, highWater: number) {
    const observed = observedRuntimeCursors.get(sessionId);
    // A fresh app process re-attaching to a broker-owned run has no observed cursor; the
    // snapshot's high-water mark says where history ends, so the whole backlog replays with
    // protocol responses suppressed instead of xterm answering stale queries into the live shell.
    replayThroughRef.current = observed?.runId === runId ? observed.next : highWater;
    if (observed?.runId !== runId) observedRuntimeCursors.delete(sessionId);
  }

  function writeOutput(bytes: Uint8Array, suppressProtocolInput: boolean) {
    const writer = outputWriterRef.current;
    if (writer) return writer(bytes, suppressProtocolInput);
    if (terminalAttachFailedRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      pendingOutputRef.current.push({ bytes, suppressProtocolInput, resolve, reject });
    });
  }

  function resolvePendingOutput() {
    for (const pending of pendingOutputRef.current.splice(0)) pending.resolve(false);
  }

  function syncObservedReadCursor() {
    const observed = observedRuntimeCursors.get(session.id);
    if (!observed || observed.runId !== runtimeStatusRef.current?.runId) return;
    cursorRef.current = Math.max(cursorRef.current, observed.next);
  }

  function recordReadCursor(runId: number, next: number): boolean {
    if (runtimeStatusRef.current?.runId !== runId) return false;
    cursorRef.current = next;
    updateRetainedCursor(session.id, runId, next);
    observedRuntimeCursors.set(session.id, { runId, next });
    return true;
  }

  function reportRuntimeStatus(
    origin: TerminalRuntimeObservationOrigin,
    status: Omit<TerminalRuntimeStatus, "observedAt">,
  ) {
    const observation: TerminalRuntimeObservation = {
      origin,
      phase: status.phase,
      runId: status.runId,
      exitCode: status.exitCode,
      termination: status.termination,
      fault: status.fault,
      observedAt: new Date().toISOString(),
    };
    const current = runtimeStatusRef.current;
    if (!shouldApplyRuntimeObservation(current, observation)) return;
    if (sameRuntimeStatus(current, observation)) return;

    runtimeStatusRef.current = observation;
    setPhase(observation.phase);
    setExitCode(observation.exitCode);
    setError(observation.fault?.message ?? null);
    runtimeObservationRef.current(session.id, observation);
  }

  function reportRuntimeFault(
    operation: TerminalRuntimeOperation,
    cause: unknown,
    phase: TerminalRuntimePhase = runtimeStatusRef.current?.phase ?? "error",
  ) {
    const current = currentRuntimeStatus(phase);
    reportRuntimeStatus("runtime-event", {
      ...current,
      phase,
      fault: { operation, message: errorMessage(cause) },
    });
  }

  function clearRuntimeFault(operation: TerminalRuntimeOperation) {
    const current = runtimeStatusRef.current;
    if (current?.fault?.operation !== operation) return;
    reportRuntimeStatus("runtime-event", { ...current, fault: null });
  }

  // `profileOverride` exists so a saved profile whose executable no longer resolves is one click
  // away from a working terminal, instead of requiring the user to go and edit the project first.
  async function start(profileOverride?: LaunchProfile) {
    const operationEpoch = advanceRuntimeEpoch();
    setRestartReady(false);
    reportRuntimeStatus("explicit-action", emptyRuntimeStatus("starting"));
    cursorRef.current = 0;
    replayThroughRef.current = 0;
    try {
      const snapshot = await ensureSessionStarted(
        createSessionSpawnInput(session.id, cwd, profileOverride ?? session.launchProfile),
        restartReady,
      );
      if (runtimeOperationsRef.current.epoch !== operationEpoch) return;
      // A fresh run must not append below the previous run's screen: clear the retained emulator
      // and rewind its cursor before the new run's bytes arrive.
      terminalRef.current?.reset();
      resetRetainedRun(session.id, snapshot.runId);
      prepareRuntimeReplay(session.id, snapshot.runId, snapshot.next);
      const nextPhase = terminalRuntimePhase("starting", snapshot.running, snapshot.readError);
      reportRuntimeStatus("runtime-event", {
        phase: nextPhase,
        runId: snapshot.runId,
        exitCode: snapshot.exitCode,
        termination: snapshot.running ? null : "observed-exit",
        fault: snapshot.readError ? { operation: "read", message: snapshot.readError } : null,
      });
    } catch (cause: unknown) {
      if (runtimeOperationsRef.current.epoch !== operationEpoch) return;
      reportRuntimeFault("start", cause, "error");
    }
  }

  async function stop() {
    const current = currentRuntimeStatus("stopping");
    if (current.runId === null) return;
    const runId = current.runId;
    const operationEpoch = advanceRuntimeEpoch();
    reportRuntimeStatus("explicit-action", {
      ...current,
      phase: "stopping",
      termination: "requested-stop",
      fault: null,
    });
    try {
      const snapshot = await sessionClient.kill(session.id, runId);
      if (runtimeOperationsRef.current.epoch !== operationEpoch) return;
      setRestartReady(!snapshot.running && snapshot.readClosed);
      reportRuntimeStatus("runtime-event", {
        phase: terminalRuntimePhase("stopping", snapshot.running, snapshot.readError),
        runId: snapshot.runId,
        exitCode: snapshot.exitCode,
        termination: "requested-stop",
        fault: snapshot.readError ? { operation: "read", message: snapshot.readError } : null,
      });
    } catch (cause: unknown) {
      if (runtimeOperationsRef.current.epoch !== operationEpoch) return;
      reportRuntimeFault("stop", cause, "error");
    }
  }

  function currentRuntimeStatus(fallbackPhase: TerminalRuntimePhase): TerminalRuntimeStatus {
    return (
      runtimeStatusRef.current ?? {
        ...emptyRuntimeStatus(fallbackPhase),
        observedAt: "",
      }
    );
  }

  function advanceRuntimeEpoch(): number {
    resolvePendingOutput();
    return invalidateRuntimeOperations(runtimeOperationsRef.current);
  }

  if (background) {
    return shouldAttachTerminal ? (
      <div className="background-session-runtime" aria-hidden="true">
        <div className="terminal-host" ref={hostRef} />
      </div>
    ) : null;
  }

  if (!terminalAttached) {
    return (
      <>
        <div className="terminal-pane__body terminal-launcher">
          <div className="terminal-launcher__preview">
            {session.lines.map((line) => (
              <div className="terminal-line" data-tone={line.tone} key={line.id}>
                {text(line.text)}
              </div>
            ))}
          </div>
          <div className="terminal-launcher__target">
            <span>{t("terminal.launchTarget")}</span>
            <span className="terminal-launcher__target-copy">
              <strong>{launchLabel}</strong>
              {launchCommand ? (
                <code>{[launchCommand, ...session.launchProfile.args].join(" ")}</code>
              ) : null}
            </span>
          </div>
          <label className="terminal-launcher__field">
            <span>{t("terminal.workingDirectory")}</span>
            <input
              value={cwd}
              onChange={(event) => setCwd(event.currentTarget.value)}
              placeholder={t("terminal.workingDirectoryPlaceholder")}
              disabled={phase === "checking" || phase === "starting"}
            />
          </label>
          <button
            className="button button--primary terminal-launcher__start"
            type="button"
            disabled={phase === "checking" || phase === "starting" || phase === "unavailable"}
            onClick={() =>
              void start(
                commandMissing
                  ? { label: session.launchProfile.label, command: null, args: [] }
                  : undefined,
              )
            }
          >
            {phase === "starting"
              ? t("terminal.starting")
              : commandMissing
                ? t("terminal.startDefaultShell")
                : t("terminal.startShell")}
          </button>
          {commandMissing ? (
            <output className="terminal-launcher__notice">
              {t("terminal.launchCommandMissing")}
            </output>
          ) : null}
          {phase === "unavailable" ? (
            <p className="terminal-launcher__notice">{t("terminal.desktopOnly")}</p>
          ) : null}
          {error ? (
            <p className="terminal-launcher__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="terminal-pane__footer">
          <span className="preview-label">{t("terminal.preview")}</span>
          <span>{runtimePhaseLabel(phase, exitCode)}</span>
          <span className="terminal-pane__footer-spacer" />
          <span>{text(session.lastActivity)}</span>
        </footer>
      </>
    );
  }

  return (
    <>
      <div
        className="terminal-pane__body terminal-pane__body--live"
        data-testid="live-terminal"
        aria-label={t("terminal.liveAria", { session: text(session.title) })}
      >
        <div className="terminal-host" ref={hostRef} />
        {scrollActive ? (
          <button type="button" className="terminal-scroll-chip" onClick={toggleScrollMode}>
            {t("terminal.scrollMode")}
          </button>
        ) : viewport.scrolledUp ? (
          <button type="button" className="terminal-scroll-chip" onClick={jumpToBottom}>
            {t("terminal.jumpToBottom")}
          </button>
        ) : null}
        <Toast notice={toast} />
      </div>
      <footer className="terminal-pane__footer">
        <span className="live-label">{t("inspector.terminalLive")}</span>
        <span data-testid="runtime-phase" data-phase={phase}>
          {runtimePhaseLabel(phase, exitCode)}
        </span>
        {error ? (
          <span className="terminal-runtime-error" title={error}>
            {error}
          </span>
        ) : null}
        <span className="terminal-pane__footer-spacer" />
        {phase === "running" ? (
          <button
            type="button"
            className="terminal-release-mouse"
            title={t("terminal.releaseMouseHint")}
            onClick={releaseMouse}
          >
            {t("terminal.releaseMouse")}
          </button>
        ) : null}
        {phase === "running" ? (
          <button
            className="terminal-stop"
            type="button"
            data-testid="stop-session"
            onClick={() => setConfirmStop(true)}
          >
            {t("terminal.stop")}
          </button>
        ) : null}
        {phase === "exited" ? (
          <button
            className="terminal-restart"
            type="button"
            disabled={!restartReady}
            title={restartReady ? undefined : t("terminal.finishingOutput")}
            onClick={() => void start()}
          >
            {t(restartReady ? "terminal.restart" : "terminal.finishingOutput")}
          </button>
        ) : null}
      </footer>
      <ConfirmDialog
        open={confirmStop}
        title={t("terminal.stopConfirmTitle")}
        body={t("terminal.stopConfirmBody", { session: text(session.title) })}
        cancelLabel={t("terminal.stopConfirmCancel")}
        onCancel={() => setConfirmStop(false)}
        actions={[
          {
            label: t("terminal.stopConfirm"),
            tone: "danger",
            onSelect: () => {
              setConfirmStop(false);
              void stop();
            },
          },
        ]}
      />
    </>
  );
}

function emptyRuntimeStatus(
  phase: TerminalRuntimePhase,
): Omit<TerminalRuntimeStatus, "observedAt"> {
  return {
    phase,
    runId: null,
    exitCode: null,
    termination: null,
    fault: null,
  };
}

function sameRuntimeStatus(
  left: TerminalRuntimeStatus | null,
  right: Omit<TerminalRuntimeStatus, "observedAt">,
): boolean {
  return (
    left !== null &&
    left.phase === right.phase &&
    left.runId === right.runId &&
    left.exitCode === right.exitCode &&
    left.termination === right.termination &&
    left.fault?.operation === right.fault?.operation &&
    left.fault?.message === right.fault?.message
  );
}
