import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { DevSession, TerminalRuntimePhase } from "../domain";
import { useI18n } from "../i18n";
import { ensureSessionStarted, errorMessage, sessionClient } from "../runtime/sessionClient";
import { createSessionSpawnInput } from "../runtime/sessionLaunch";

const POLL_INTERVAL_MS = 75;

interface SessionTerminalProps {
  session: DevSession;
  projectPath: string;
  focused: boolean;
  onRuntimeAttached: (attached: boolean) => void;
  onLaunchHandled: (sessionId: string) => void;
  onPhaseChange: (sessionId: string, phase: TerminalRuntimePhase) => void;
}

export function SessionTerminal({
  session,
  projectPath,
  focused,
  onRuntimeAttached,
  onLaunchHandled,
  onPhaseChange,
}: SessionTerminalProps) {
  const { t } = useI18n();
  const launchCommand = session.launchProfile.command?.trim() || null;
  const launchLabel = session.launchProfile.label || t("terminal.defaultShell");
  const [phase, setPhase] = useState<TerminalRuntimePhase>("checking");
  const [cwd, setCwd] = useState(projectPath);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const cursorRef = useRef(0);
  const pendingOutputRef = useRef<Uint8Array[]>([]);
  const focusedRef = useRef(focused);
  const launchRequestedRef = useRef(session.launchRequested === true);
  const launchHandledRef = useRef(onLaunchHandled);
  const phaseChangeRef = useRef(onPhaseChange);
  focusedRef.current = focused;
  launchRequestedRef.current = session.launchRequested === true;
  launchHandledRef.current = onLaunchHandled;
  phaseChangeRef.current = onPhaseChange;
  const terminalAttached = phase === "running" || phase === "stopping" || phase === "exited";

  useEffect(() => onRuntimeAttached(terminalAttached), [onRuntimeAttached, terminalAttached]);

  useEffect(() => {
    phaseChangeRef.current(session.id, phase);
  }, [phase, session.id]);

  useEffect(() => {
    const shouldLaunch = launchRequestedRef.current;
    setCwd(projectPath);
    setError(null);
    setExitCode(null);
    cursorRef.current = 0;
    pendingOutputRef.current = [];
    if (!sessionClient.available()) {
      setPhase("unavailable");
      if (shouldLaunch) launchHandledRef.current(session.id);
      return;
    }

    let cancelled = false;
    setPhase(shouldLaunch ? "starting" : "checking");
    const request = createSessionSpawnInput(session.id, projectPath, session.launchProfile);
    const snapshot = shouldLaunch
      ? ensureSessionStarted(request)
      : sessionClient.snapshot(session.id);
    void snapshot
      .then((snapshot) => {
        if (cancelled) return;
        if (!snapshot) {
          setPhase("idle");
          return;
        }
        setExitCode(snapshot.exitCode);
        setError(snapshot.readError);
        setPhase(snapshot.running || !snapshot.readClosed ? "running" : "exited");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setPhase("error");
      })
      .finally(() => {
        if (shouldLaunch && !cancelled) launchHandledRef.current(session.id);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, session.id, session.launchProfile]);

  useEffect(() => {
    if (!terminalAttached || !hostRef.current) return;
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
        for (const chunk of pendingOutputRef.current) terminal.write(chunk);
        pendingOutputRef.current = [];

        const sendInput = terminal.onData((data) => {
          void sessionClient
            .write(session.id, new TextEncoder().encode(data))
            .catch((cause: unknown) => setError(errorMessage(cause)));
        });
        const sendResize = terminal.onResize(({ cols, rows }) => {
          void sessionClient
            .resize(session.id, cols, rows)
            .catch((cause: unknown) => setError(errorMessage(cause)));
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
          } catch (cause: unknown) {
            setError(errorMessage(cause));
          }
        };
        const frame = requestAnimationFrame(() => {
          fit();
          if (focusedRef.current && canMoveTerminalFocus()) terminal.focus();
        });
        const observer = new ResizeObserver(fit);
        observer.observe(hostRef.current);
        disposeTerminal = () => {
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
        setError(errorMessage(cause));
        setPhase("error");
      });

    return () => {
      disposed = true;
      disposeTerminal?.();
    };
  }, [session.id, terminalAttached]);

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
    if (phase !== "running" && phase !== "stopping") return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const read = await sessionClient.read(session.id, cursorRef.current);
        if (cancelled) return;
        cursorRef.current = read.next;
        if (read.truncated) {
          writeOutput(new TextEncoder().encode(`\r\n${t("terminal.historyTruncated")}\r\n`));
        }
        if (read.bytes.length > 0) writeOutput(Uint8Array.from(read.bytes));
        setExitCode(read.exitCode);
        if (read.readError) setError(read.readError);
        if (!read.running && read.readClosed) {
          setPhase("exited");
          return;
        }
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause: unknown) {
        if (cancelled) return;
        setError(errorMessage(cause));
        setPhase("error");
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, session.id, t]);

  function writeOutput(bytes: Uint8Array) {
    if (terminalRef.current) terminalRef.current.write(bytes);
    else pendingOutputRef.current.push(bytes);
  }

  async function start() {
    setError(null);
    setExitCode(null);
    setPhase("starting");
    cursorRef.current = 0;
    pendingOutputRef.current = [];
    try {
      const snapshot = await ensureSessionStarted(
        createSessionSpawnInput(session.id, cwd, session.launchProfile),
      );
      setExitCode(snapshot.exitCode);
      setError(snapshot.readError);
      setPhase(snapshot.running || !snapshot.readClosed ? "running" : "exited");
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  async function stop() {
    setError(null);
    setPhase("stopping");
    try {
      const snapshot = await sessionClient.kill(session.id);
      setExitCode(snapshot.exitCode);
      if (snapshot.readClosed) setPhase("exited");
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  if (!terminalAttached) {
    return (
      <>
        <div className="terminal-pane__body terminal-launcher">
          <div className="terminal-launcher__preview">
            {session.lines.map((line) => (
              <div className="terminal-line" data-tone={line.tone} key={line.id}>
                {line.text}
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
          <span>{phaseLabel(phase, exitCode, t)}</span>
          <span className="terminal-pane__footer-spacer" />
          <span>{session.lastActivity}</span>
        </footer>
      </>
    );
  }

  return (
    <>
      <div
        className="terminal-pane__body terminal-pane__body--live"
        data-testid="live-terminal"
        aria-label={t("terminal.liveAria", { session: session.title })}
      >
        <div className="terminal-host" ref={hostRef} />
      </div>
      <footer className="terminal-pane__footer">
        <span className="live-label">LIVE PTY</span>
        <span data-testid="runtime-phase" data-phase={phase}>
          {phaseLabel(phase, exitCode, t)}
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

function phaseLabel(
  phase: TerminalRuntimePhase,
  exitCode: number | null,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (phase === "running") return t("terminal.running");
  if (phase === "stopping") return t("terminal.stopping");
  if (phase === "exited")
    return exitCode === null ? t("terminal.exited") : t("terminal.exitedCode", { code: exitCode });
  if (phase === "error") return t("terminal.failed");
  if (phase === "unavailable") return t("terminal.ptyDisconnected");
  return t("terminal.readyToStart");
}

function canMoveTerminalFocus(): boolean {
  if (document.querySelector("dialog[open]")) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active.classList.contains("xterm-helper-textarea")) return true;
  return !(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
}
