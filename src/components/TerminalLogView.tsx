import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { platformFromUserAgent } from "../platform";
import { errorMessage, sessionClient } from "../runtime/sessionClient";
import { readSessionLogFrame } from "../runtime/sessionLogModel";
import { createTerminalOutputWriter } from "../runtime/terminalOutputWriter";
import { nextReadDelayMs, terminalReadShouldContinue } from "../runtime/terminalReplay";
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

// Exact internal polling intervals, not product latency guarantees.
const LOG_LIVE_POLL_MS = 200;
const LOG_IDLE_POLL_MS = 750;

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
    let timer: number | undefined;
    let disposeTerminal: (() => void) | undefined;
    setPhase("loading");

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(async ([{ Terminal }, { FitAddon }]) => {
        // A previous mount may have detached while xterm was still parsing its final chunk. Its
        // cursor is committed with that write; wait before reattaching or issuing another read.
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

        const poll = async () => {
          try {
            await waitForRetainedTerminalLogCommit(sessionId);
            if (disposed) return;
            const retained = retainedTerminalLog(sessionId);
            if (!retained) return;
            const next = await readSessionLogFrame(sessionClient, sessionId, retained.cursor);
            if (disposed) return;
            if (next.reset) {
              terminal.reset();
            }
            const retainedTruncated = next.reset
              ? next.truncated
              : retained.truncated || next.truncated;
            const committed = await commitRetainedTerminalLogFrame(
              sessionId,
              next.cursor,
              retainedTruncated,
              () =>
                next.bytes.length > 0
                  ? output.write(Uint8Array.from(next.bytes), false)
                  : Promise.resolve(true),
            );
            if (!committed) return;
            if (disposed) return;
            setTruncated(retainedTruncated);
            setError(next.readError);
            setPhase(next.running ? "running" : "exited");
            if (!terminalReadShouldContinue(next.running, next.readClosed, next.bytes.length)) {
              return;
            }
            timer = window.setTimeout(
              () => void poll(),
              nextReadDelayMs(next.running, next.bytes.length, LOG_LIVE_POLL_MS),
            );
          } catch (cause: unknown) {
            if (disposed) return;
            setError(errorMessage(cause));
            setPhase("waiting");
            timer = window.setTimeout(() => void poll(), LOG_IDLE_POLL_MS);
          }
        };
        void poll();

        disposeTerminal = () => {
          if (timer !== undefined) window.clearTimeout(timer);
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
