import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { platformFromUserAgent } from "../platform";
import { errorMessage, sessionClient } from "../runtime/sessionClient";
import { initialSessionLogCursor, readSessionLogFrame } from "../runtime/sessionLogModel";
import { terminalReadShouldContinue } from "../runtime/terminalReplay";
import { attachTerminalClipboard } from "../terminalClipboard";
import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "../terminalTheme";

// Exact internal polling intervals, not product latency guarantees.
const LOG_LIVE_POLL_MS = 200;
const LOG_IDLE_POLL_MS = 750;

type TerminalLogPhase = "loading" | "running" | "exited" | "waiting" | "unavailable";

export function TerminalLogView({ sessionId }: { sessionId: string }) {
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
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return;
        const terminal: XTerm = new Terminal({
          convertEol: false,
          cursorBlink: false,
          disableStdin: true,
          screenReaderMode: true,
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 12,
          scrollback: 5000,
          theme: TERMINAL_THEME,
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        attachTerminalClipboard(terminal, platformFromUserAgent(navigator.userAgent));

        const fit = () => {
          if (
            !hostRef.current ||
            hostRef.current.clientWidth === 0 ||
            hostRef.current.clientHeight === 0
          ) {
            return;
          }
          try {
            fitAddon.fit();
          } catch (cause: unknown) {
            setError(errorMessage(cause));
          }
        };
        const frame = requestAnimationFrame(fit);
        const observer = new ResizeObserver(fit);
        observer.observe(hostRef.current);

        let cursor = initialSessionLogCursor;
        const poll = async () => {
          let delay = LOG_IDLE_POLL_MS;
          try {
            const next = await readSessionLogFrame(sessionClient, sessionId, cursor);
            if (disposed) return;
            if (next.reset) {
              terminal.reset();
              setTruncated(next.truncated);
            } else if (next.truncated) {
              setTruncated(true);
            }
            cursor = next.cursor;
            if (next.bytes.length > 0) terminal.write(Uint8Array.from(next.bytes));
            setError(next.readError);
            setPhase(next.running ? "running" : "exited");
            const draining = terminalReadShouldContinue(
              next.running,
              next.readClosed,
              next.bytes.length,
            );
            delay = draining ? LOG_LIVE_POLL_MS : LOG_IDLE_POLL_MS;
          } catch (cause: unknown) {
            if (disposed) return;
            setError(errorMessage(cause));
            setPhase("waiting");
          }
          timer = window.setTimeout(() => void poll(), delay);
        };
        void poll();

        disposeTerminal = () => {
          if (timer !== undefined) window.clearTimeout(timer);
          cancelAnimationFrame(frame);
          observer.disconnect();
          terminal.dispose();
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
  }, [available, sessionId]);

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
