import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { platformFromUserAgent } from "../platform";
import { type SessionSubscription, errorMessage, sessionClient } from "../runtime/sessionClient";
import { sessionLogResumePoint } from "../runtime/sessionLogModel";
import { createTerminalOutputWriter } from "../runtime/terminalOutputWriter";
import { createTerminalStreamConsumer } from "../runtime/terminalStream";
import { attachTerminalClipboard } from "../terminalClipboard";
import { createTerminalFitter } from "../terminalFit";
import {
  commitRetainedTerminalLogFrame,
  releaseTerminalLog,
  retainTerminalLog,
  retainedTerminalLog,
  waitForRetainedTerminalLogCommit,
} from "../terminalLogInstances";
import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "../terminalTheme";

type TerminalLogPhase = "loading" | "running" | "exited" | "waiting" | "unavailable";

interface TerminalLogViewProps {
  sessionId: string;
  /** Restarts a drained log reader when the same session starts a new broker run. */
  currentRunId?: number | null;
}

export function TerminalLogView({ sessionId, currentRunId = null }: TerminalLogViewProps) {
  const { t } = useI18n();
  const available = sessionClient.available();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<TerminalLogPhase>(available ? "loading" : "unavailable");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTruncated(false);
    setError(null);
    if (!available || !hostRef.current) {
      setPhase("unavailable");
      return;
    }

    let disposed = false;
    let disposeTerminal: (() => void) | undefined;
    setPhase("loading");

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(async ([{ Terminal }, { FitAddon }]) => {
        // A previous mount may have detached while xterm was still parsing its final chunk. Its
        // cursor is committed with that write; wait before reattaching or opening a new stream.
        await waitForRetainedTerminalLogCommit(sessionId);
        if (disposed || !hostRef.current) return;
        const kept = retainedTerminalLog(sessionId);
        let terminal: XTerm;
        let fitAddon: InstanceType<typeof FitAddon>;
        if (kept?.terminal.element) {
          terminal = kept.terminal;
          fitAddon = kept.fitAddon;
          hostRef.current.appendChild(kept.terminal.element);
          setTruncated(kept.truncated);
        } else {
          if (kept) releaseTerminalLog(sessionId);
          terminal = new Terminal({
            convertEol: false,
            cursorBlink: false,
            disableStdin: true,
            screenReaderMode: false,
            fontFamily: TERMINAL_FONT_FAMILY,
            fontSize: 12,
            scrollback: 10000,
            theme: TERMINAL_THEME,
          });
          fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);
          terminal.open(hostRef.current);
          retainTerminalLog(sessionId, {
            terminal,
            fitAddon,
            cursor: { runId: currentRunId, after: 0 },
            truncated: false,
          });
        }
        const detachClipboard = attachTerminalClipboard(
          terminal,
          platformFromUserAgent(navigator.userAgent),
          undefined,
          (message) => {
            if (!disposed) setError(message);
          },
        );

        const output = createTerminalOutputWriter(
          (bytes, done) => terminal.write(bytes, done),
          () => undefined,
        );

        const fitter = createTerminalFitter(
          terminal,
          fitAddon,
          () => hostRef.current,
          (cause) => setError(errorMessage(cause)),
        );
        const frame = requestAnimationFrame(fitter.schedule);
        const observer = new ResizeObserver(fitter.schedule);
        observer.observe(hostRef.current);

        const retained = retainedTerminalLog(sessionId);
        if (!retained) return;
        // A new run of the same session id starts a fresh log; the retained cursor belongs to
        // the old one.
        const resume = sessionLogResumePoint(retained.cursor, currentRunId);
        if (resume.reset) {
          terminal.reset();
          retained.cursor = { runId: currentRunId, after: 0 };
          retained.truncated = false;
          setTruncated(false);
        }
        let truncatedSeen = retained.truncated;
        let subscription: SessionSubscription | null = null;
        const consumer = createTerminalStreamConsumer({
          commit: ({ runId, next, bytes }) =>
            commitRetainedTerminalLogFrame(sessionId, { runId, after: next }, truncatedSeen, () =>
              bytes.length > 0 ? output.write(bytes, false) : Promise.resolve(true),
            ),
          // The gap is announced above the log, not painted into it.
          truncatedMarker: () => new Uint8Array(0),
          // Read-only: xterm never answers a query here, so nothing needs suppressing.
          replayThrough: () => 0,
          status: (frame) => {
            if (disposed) return;
            setTruncated(truncatedSeen);
            setError(frame.error);
            setPhase(frame.running ? "running" : "exited");
          },
        });
        void sessionClient
          .attach(sessionId, resume.after, (frame) => {
            if (disposed) return;
            if (frame.runId === 0 && frame.ended) {
              setError(frame.error);
              setPhase("waiting");
              return;
            }
            if (frame.truncated) truncatedSeen = true;
            void consumer.push(frame);
          })
          .then((opened) => {
            if (disposed) void opened.detach();
            else subscription = opened;
          })
          .catch((cause: unknown) => {
            if (disposed) return;
            setError(errorMessage(cause));
            setPhase("waiting");
          });

        disposeTerminal = () => {
          consumer.stop();
          if (subscription) void subscription.detach();
          output.dispose();
          cancelAnimationFrame(frame);
          fitter.dispose();
          observer.disconnect();
          detachClipboard();
          terminal.element?.remove();
        };
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(errorMessage(cause));
        setPhase("waiting");
      });

    return () => {
      disposed = true;
      disposeTerminal?.();
    };
  }, [available, currentRunId, sessionId]);

  return (
    <div className="inspector__content terminal-log" data-testid="terminal-log-view">
      <div className="terminal-log__meta">
        <span data-phase={phase}>{terminalLogPhaseLabel(phase, t)}</span>
        <span>{t("inspector.terminalMemoryOnly")}</span>
      </div>
      {truncated ? (
        <p className="terminal-log__notice">{t("inspector.terminalTruncated")}</p>
      ) : null}
      {available ? (
        <div
          className="terminal-log__host"
          ref={hostRef}
          aria-label={t("inspector.terminalAria")}
        />
      ) : (
        <div className="terminal-log__empty">{t("inspector.terminalDesktopOnly")}</div>
      )}
      {error ? <output className="terminal-log__error">{error}</output> : null}
    </div>
  );
}

function terminalLogPhaseLabel(
  phase: TerminalLogPhase,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (phase === "running") return t("inspector.terminalLive");
  if (phase === "exited") return t("inspector.terminalExited");
  if (phase === "waiting") return t("inspector.terminalWaiting");
  if (phase === "unavailable") return t("inspector.terminalUnavailable");
  return t("inspector.terminalLoading");
}
