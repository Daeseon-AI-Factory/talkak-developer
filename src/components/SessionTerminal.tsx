import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type {
  DevSession,
  TerminalRuntimeObservation,
  TerminalRuntimeObservationOrigin,
  TerminalRuntimeOperation,
  TerminalRuntimePhase,
  TerminalRuntimeStatus,
} from "../domain";
import { useI18n } from "../i18n";
import {
  beginRuntimeOperation,
  createRuntimeMutationQueue,
  createRuntimeOperationTracker,
  enqueueRuntimeMutation,
  invalidateRuntimeOperations,
  runtimeOperationBelongsToCurrentRuntime,
  runtimeOperationIsCurrent,
} from "../runtime/runtimeOperationGuard";
import { ensureSessionStarted, errorMessage, sessionClient } from "../runtime/sessionClient";
import { createSessionSpawnInput } from "../runtime/sessionLaunch";
import { partitionTerminalOutput, terminalPollingEnabled } from "../runtime/terminalReplay";
import { shouldApplyRuntimeObservation } from "../sessionRuntimeState";

const POLL_INTERVAL_MS = 75;

interface ObservedRuntimeCursor {
  runId: number;
  next: number;
}

interface PendingTerminalOutput {
  bytes: Uint8Array;
  suppressProtocolInput: boolean;
  resolve: () => void;
}

type TerminalOutputWriter = (bytes: Uint8Array, suppressProtocolInput: boolean) => Promise<void>;

const observedRuntimeCursors = new Map<string, ObservedRuntimeCursor>();
const runtimeMutationQueue = createRuntimeMutationQueue();

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
  const { runtimePhaseLabel, t, text } = useI18n();
  const launchCommand = session.launchProfile.command?.trim() || null;
  const launchLabel = session.launchProfile.label || t("terminal.defaultShell");
  const [phase, setPhase] = useState<TerminalRuntimePhase>("checking");
  const [cwd, setCwd] = useState(projectPath);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const cursorRef = useRef(0);
  const replayThroughRef = useRef(0);
  const pendingOutputRef = useRef<PendingTerminalOutput[]>([]);
  const outputWriterRef = useRef<TerminalOutputWriter | null>(null);
  const suppressProtocolInputRef = useRef(false);
  const terminalAttachFailedRef = useRef(false);
  const focusedRef = useRef(focused);
  const launchRequestedRef = useRef(session.launchRequested === true);
  const launchHandledRef = useRef(onLaunchHandled);
  const runtimeObservationRef = useRef(onRuntimeObservation);
  const runtimeStatusRef = useRef<TerminalRuntimeStatus | null>(session.runtimeStatus ?? null);
  const runtimeOperationsRef = useRef(createRuntimeOperationTracker());
  const storedRuntimeStatusRef = useRef(session.runtimeStatus);
  focusedRef.current = focused;
  launchRequestedRef.current = session.launchRequested === true;
  launchHandledRef.current = onLaunchHandled;
  runtimeObservationRef.current = onRuntimeObservation;
  storedRuntimeStatusRef.current = session.runtimeStatus;
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
    cursorRef.current = 0;
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
          reportRuntimeStatus("passive-probe", emptyRuntimeStatus("idle"));
          return;
        }
        prepareRuntimeReplay(session.id, snapshot.runId);
        const previous = currentRuntimeStatus("checking");
        const sameRun = previous.runId === snapshot.runId;
        const active = snapshot.running || !snapshot.readClosed;
        const nextPhase = snapshot.readError
          ? "error"
          : active
            ? sameRun && previous.phase === "stopping"
              ? "stopping"
              : "running"
            : "exited";
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

  useEffect(() => {
    if (!shouldAttachTerminal || !hostRef.current) return;
    terminalAttachFailedRef.current = false;
    let disposed = false;
    let disposeTerminal: (() => void) | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return;
        const terminal = new Terminal({
          convertEol: false,
          cursorBlink: true,
          fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
          fontSize: 12,
          scrollback: 5000,
          theme: {
            background: "#071216",
            foreground: "#c4dadd",
            cursor: "#86f3f7",
            selectionBackground: "#23454d",
          },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        let writeChain = Promise.resolve();
        const activeWrites = new Set<() => void>();
        const enqueueOutput: TerminalOutputWriter = (bytes, suppressProtocolInput) => {
          let settled = false;
          return new Promise<void>((resolve) => {
            const finish = () => {
              if (settled) return;
              settled = true;
              activeWrites.delete(finish);
              suppressProtocolInputRef.current = false;
              resolve();
            };
            activeWrites.add(finish);
            writeChain = writeChain.then(() => {
              if (disposed) {
                finish();
                return;
              }
              suppressProtocolInputRef.current = suppressProtocolInput;
              terminal.write(bytes, finish);
            });
          });
        };
        outputWriterRef.current = enqueueOutput;
        const sendInput = terminal.onData((data) => {
          if (suppressProtocolInputRef.current) return;
          const current = runtimeStatusRef.current;
          if (!current || current.phase !== "running" || current.runId === null) return;
          const runId = current.runId;
          const token = beginRuntimeOperation(runtimeOperationsRef.current, "write", current);
          const bytes = new TextEncoder().encode(data);
          void enqueueRuntimeMutation(
            runtimeMutationQueue,
            JSON.stringify([session.id, runId, "write"]),
            async () => {
              await sessionClient.write(session.id, runId, bytes);
            },
            (cause) => {
              if (
                runtimeOperationBelongsToCurrentRuntime(
                  runtimeOperationsRef.current,
                  token,
                  runtimeStatusRef.current,
                )
              ) {
                reportRuntimeFault("write", cause);
              }
            },
          );
        });
        for (const pending of pendingOutputRef.current.splice(0)) {
          void enqueueOutput(pending.bytes, pending.suppressProtocolInput).then(pending.resolve);
        }
        const sendResize = terminal.onResize(({ cols, rows }) => {
          const current = runtimeStatusRef.current;
          if (!current || current.phase !== "running" || current.runId === null) return;
          const runId = current.runId;
          const token = beginRuntimeOperation(runtimeOperationsRef.current, "resize", current);
          void enqueueRuntimeMutation(
            runtimeMutationQueue,
            JSON.stringify([session.id, runId, "resize"]),
            async () => {
              await sessionClient.resize(session.id, runId, cols, rows);
              if (
                runtimeOperationIsCurrent(
                  runtimeOperationsRef.current,
                  token,
                  runtimeStatusRef.current,
                )
              ) {
                clearRuntimeFault("resize");
              }
            },
            (cause) => {
              if (
                runtimeOperationBelongsToCurrentRuntime(
                  runtimeOperationsRef.current,
                  token,
                  runtimeStatusRef.current,
                )
              ) {
                reportRuntimeFault("resize", cause);
              }
            },
          );
        });
        const fit = () => {
          if (
            !hostRef.current ||
            hostRef.current.clientWidth === 0 ||
            hostRef.current.clientHeight === 0
          )
            return;
          try {
            fitAddon.fit();
            clearRuntimeFault("attach");
          } catch (cause: unknown) {
            reportRuntimeFault("attach", cause);
          }
        };
        const frame = requestAnimationFrame(() => {
          fit();
          if (focusedRef.current && canMoveTerminalFocus()) terminal.focus();
        });
        const observer = new ResizeObserver(fit);
        observer.observe(hostRef.current);
        disposeTerminal = () => {
          disposed = true;
          if (outputWriterRef.current === enqueueOutput) outputWriterRef.current = null;
          for (const finish of [...activeWrites]) finish();
          cancelAnimationFrame(frame);
          observer.disconnect();
          sendInput.dispose();
          sendResize.dispose();
          terminal.dispose();
          terminalRef.current = null;
        };
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        terminalAttachFailedRef.current = true;
        resolvePendingOutput();
        reportRuntimeFault("attach", cause);
      });

    return () => {
      disposed = true;
      resolvePendingOutput();
      disposeTerminal?.();
    };
  }, [session.id, shouldAttachTerminal]);

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
    if (!terminalPollingEnabled(phase, background)) return;
    let cancelled = false;
    let timer: number | undefined;
    const pollEpoch = runtimeOperationsRef.current.epoch;

    const pollIsCurrent = () => !cancelled && runtimeOperationsRef.current.epoch === pollEpoch;

    const poll = async () => {
      if (!pollIsCurrent()) return;
      try {
        const read = await sessionClient.read(session.id, cursorRef.current);
        if (!pollIsCurrent()) return;
        if (read.truncated) {
          await writeOutput(
            new TextEncoder().encode(`\r\n${t("terminal.historyTruncated")}\r\n`),
            true,
          );
          if (!pollIsCurrent()) return;
        }
        const output = Uint8Array.from(read.bytes);
        const replayThrough =
          !read.running && read.readClosed ? Number.POSITIVE_INFINITY : replayThroughRef.current;
        for (const chunk of partitionTerminalOutput(output, read.start, replayThrough)) {
          if (!pollIsCurrent()) return;
          await writeOutput(chunk.bytes, chunk.suppressProtocolInput);
          if (!pollIsCurrent()) return;
        }
        cursorRef.current = read.next;
        observedRuntimeCursors.set(session.id, { runId: read.runId, next: read.next });
        const previous = currentRuntimeStatus(phase);
        const fault = read.readError
          ? { operation: "read" as const, message: read.readError }
          : previous.fault?.operation === "read"
            ? null
            : previous.fault;
        if (!read.running && read.readClosed) {
          if (read.bytes.length > 0 && !read.readError) {
            reportRuntimeStatus("runtime-event", {
              phase: previous.phase === "stopping" ? "stopping" : "running",
              runId: read.runId,
              exitCode: read.exitCode,
              termination: previous.termination,
              fault,
            });
            timer = window.setTimeout(poll, 0);
            return;
          }
          reportRuntimeStatus("runtime-event", {
            phase: read.readError ? "error" : "exited",
            runId: read.runId,
            exitCode: read.exitCode,
            termination: previous.termination ?? "observed-exit",
            fault,
          });
          return;
        }
        reportRuntimeStatus("runtime-event", {
          phase: previous.phase === "stopping" ? "stopping" : "running",
          runId: read.runId,
          exitCode: read.exitCode,
          termination: previous.phase === "stopping" ? "requested-stop" : null,
          fault,
        });
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause: unknown) {
        if (!pollIsCurrent()) return;
        reportRuntimeFault("read", cause, "error");
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [background, phase, session.id, t]);

  function prepareRuntimeReplay(sessionId: string, runId: number) {
    const observed = observedRuntimeCursors.get(sessionId);
    replayThroughRef.current = observed?.runId === runId ? observed.next : 0;
    if (observed?.runId !== runId) observedRuntimeCursors.delete(sessionId);
  }

  function writeOutput(bytes: Uint8Array, suppressProtocolInput: boolean) {
    const writer = outputWriterRef.current;
    if (writer) return writer(bytes, suppressProtocolInput);
    if (terminalAttachFailedRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pendingOutputRef.current.push({ bytes, suppressProtocolInput, resolve });
    });
  }

  function resolvePendingOutput() {
    for (const pending of pendingOutputRef.current.splice(0)) pending.resolve();
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

  async function start() {
    const operationEpoch = advanceRuntimeEpoch();
    reportRuntimeStatus("explicit-action", emptyRuntimeStatus("starting"));
    cursorRef.current = 0;
    replayThroughRef.current = 0;
    try {
      const snapshot = await ensureSessionStarted(
        createSessionSpawnInput(session.id, cwd, session.launchProfile),
      );
      if (runtimeOperationsRef.current.epoch !== operationEpoch) return;
      prepareRuntimeReplay(session.id, snapshot.runId);
      const active = snapshot.running || !snapshot.readClosed;
      reportRuntimeStatus("runtime-event", {
        phase: snapshot.readError ? "error" : active ? "running" : "exited",
        runId: snapshot.runId,
        exitCode: snapshot.exitCode,
        termination: active ? null : "observed-exit",
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
      reportRuntimeStatus("runtime-event", {
        phase: snapshot.readError ? "error" : snapshot.readClosed ? "exited" : "stopping",
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
            onClick={() => void start()}
          >
            {phase === "starting" ? t("terminal.starting") : t("terminal.startShell")}
          </button>
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
      </div>
      <footer className="terminal-pane__footer">
        <span className="live-label">LIVE PTY</span>
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
            className="terminal-stop"
            type="button"
            data-testid="stop-session"
            onClick={() => void stop()}
          >
            {t("terminal.stop")}
          </button>
        ) : null}
        {phase === "exited" ? (
          <button className="terminal-restart" type="button" onClick={() => void start()}>
            {t("terminal.restart")}
          </button>
        ) : null}
      </footer>
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

function canMoveTerminalFocus(): boolean {
  if (document.querySelector("dialog[open]")) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active.classList.contains("xterm-helper-textarea")) return true;
  return !(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
}
