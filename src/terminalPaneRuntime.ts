import type { FitAddon } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ShownToast } from "./components/Toast";
import { useToast } from "./components/Toast";
import type { TerminalRuntimeOperation, TerminalRuntimeStatus } from "./domain";
import { type Locale, translate } from "./i18n";
import type { MessageKey } from "./i18n/strings";
import { platformFromUserAgent } from "./platform";
import {
  type OpenSourceLocationRequest,
  hostInfo,
  openSourceLocation,
  windowsPtyOption,
} from "./runtime/hostClient";
import {
  type RuntimeOperationTracker,
  beginRuntimeOperation,
  enqueueRuntimeMutation,
  runtimeOperationBelongsToCurrentRuntime,
  runtimeOperationIsCurrent,
} from "./runtime/runtimeOperationGuard";
import { sessionClient } from "./runtime/sessionClient";
import { runtimeMutationQueue, sendSessionInput } from "./runtime/sessionInput";
import {
  type TerminalOutputWriter,
  createTerminalOutputWriter,
} from "./runtime/terminalOutputWriter";
import type { SourceLocation } from "./sourceLocations";
import {
  type TerminalClipboardNotice,
  attachTerminalClipboard,
  createOsc52ClipboardProvider,
} from "./terminalClipboard";
import { activeTerminalEditorSetting } from "./terminalEditorSettings";
import { createTerminalFitter } from "./terminalFit";
import {
  type RetainedPaneCallbacks,
  bindRetainedPane,
  releaseTerminal,
  resetInteractionModes,
  retainTerminal,
  retainedTerminal,
  unbindRetainedPane,
} from "./terminalInstances";
import { attachSourceLinks, sourceOpenFailureKey } from "./terminalLinks";
import {
  type ScrollModeHost,
  type TerminalViewportState,
  attachScrollMode,
  jumpTerminalToBottom,
  registerScrollModeHandle,
  toggleTerminalScrollMode,
  watchTerminalViewport,
} from "./terminalScrollMode";
import { TERMINAL_FONT_FAMILY, activeTerminalTheme } from "./terminalTheme";

/**
 * Mounting the pane's xterm instance and everything that only makes sense once it exists: the
 * retained-emulator lifecycle, clipboard (keyboard chords and OSC 52), `path:line` links, scroll
 * mode, and the PTY resize RPC. Pulled out of SessionTerminal.tsx so that component stays a
 * runtime-status/launcher component and this stays an emulator-wiring one (AGENTS.md law 5).
 *
 * A DEC-mode reset action is exposed too (G23): an agent's TUI can exit without restoring the
 * mouse-tracking/focus-reporting modes it turned on, and the escape hatch has to reach the
 * RETAINED emulator, not just whichever mount happens to be live.
 */

export interface PendingTerminalOutput {
  bytes: Uint8Array;
  suppressProtocolInput: boolean;
  resolve: (written: boolean) => void;
  reject: (cause: unknown) => void;
}

const protocolInputSuppressedSessions = new Set<string>();

export interface TerminalPaneRuntimeParams {
  sessionId: string;
  shouldAttachTerminal: boolean;
  locale: Locale;
  hostRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<XTerm | null>;
  pendingOutputRef: RefObject<PendingTerminalOutput[]>;
  outputWriterRef: RefObject<TerminalOutputWriter | null>;
  terminalAttachFailedRef: RefObject<boolean>;
  focusedRef: RefObject<boolean>;
  /** Latest working directory and project root, for resolving a clicked `path:line` reference. */
  cwdRef: RefObject<string>;
  projectRootRef: RefObject<string>;
  runtimeStatusRef: RefObject<TerminalRuntimeStatus | null>;
  runtimeOperationsRef: RefObject<RuntimeOperationTracker>;
  reportRuntimeFault: (operation: TerminalRuntimeOperation, cause: unknown) => void;
  clearRuntimeFault: (operation: TerminalRuntimeOperation) => void;
  setError: (message: string | null) => void;
}

export interface TerminalPaneRuntimeHandle {
  toast: ShownToast | null;
  scrollActive: boolean;
  viewport: TerminalViewportState;
  jumpToBottom: () => void;
  toggleScrollMode: () => void;
  releaseMouse: () => void;
}

const SOURCE_FAILURE_DETAIL_KEYS: readonly MessageKey[] = [
  "terminal.sourceEditorFailed",
  "terminal.sourceOpenFailed",
];

export function useTerminalPaneRuntime(
  params: TerminalPaneRuntimeParams,
): TerminalPaneRuntimeHandle {
  const {
    sessionId,
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
  } = params;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const { toast, show: showToast } = useToast();
  const [scrollActive, setScrollActive] = useState(false);
  const [viewport, setViewport] = useState<TerminalViewportState>({
    scrolledUp: false,
    mouseOwned: false,
  });

  // Every other value this effect reads is a ref refreshed by the caller each render and read
  // only at call time, or a callback whose own body only closes over such refs — remounting on
  // any of them would tear down and replay the retained emulator, so only these two belong here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and ref-closing callbacks only, see above
  useEffect(() => {
    if (!shouldAttachTerminal || !hostRef.current) return;
    terminalAttachFailedRef.current = false;
    let disposed = false;
    let disposeTerminal: (() => void) | undefined;

    async function openLocation(location: SourceLocation, text: string) {
      const editor = activeTerminalEditorSetting();
      const request: OpenSourceLocationRequest = {
        cwd: cwdRef.current ?? "",
        projectRoot: projectRootRef.current ?? "",
        path: location.path,
        line: location.line,
        column: location.column,
        editorCommand: editor.command,
        editorArgsTemplate: editor.argsTemplate.length > 0 ? editor.argsTemplate : null,
      };
      const failure = await openSourceLocation(request);
      if (disposed) return;
      if (!failure) {
        showToast({
          tone: "ok",
          text: translate(localeRef.current, "terminal.sourceOpened", { ref: text }),
        });
        return;
      }
      const key = sourceOpenFailureKey(failure);
      const vars: Record<string, string> = SOURCE_FAILURE_DETAIL_KEYS.includes(key)
        ? { detail: failure.detail || text }
        : { ref: text };
      showToast({ tone: "error", text: translate(localeRef.current, key, vars) });
    }

    function handleClipboardNotice(notice: TerminalClipboardNotice) {
      const text =
        notice.kind === "copied"
          ? translate(localeRef.current, "terminal.copied", { text: notice.text })
          : translate(localeRef.current, "terminal.imagePathPasted", { path: notice.path });
      showToast({ tone: "ok", text });
    }

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-clipboard"),
      hostInfo(),
    ])
      .then(([{ Terminal }, { FitAddon }, { ClipboardAddon }, host]) => {
        if (disposed || !hostRef.current) return;
        // Reuse the retained emulator when its buffer belongs to the current run: the pane comes
        // back exactly as it looked and reads only the bytes that arrived while it was away — no
        // replay, no crawl. A different (or unknown-yet-different) run starts clean.
        const kept = retainedTerminal(sessionId);
        const currentRunId = runtimeStatusRef.current?.runId ?? null;
        let terminal: XTerm;
        let fitAddon: FitAddon;
        const reusable =
          kept !== undefined &&
          kept.terminal.element != null &&
          (currentRunId === null || kept.runId === currentRunId);
        if (kept && reusable && kept.terminal.element) {
          terminal = kept.terminal;
          fitAddon = kept.fitAddon;
          hostRef.current.appendChild(kept.terminal.element);
          // The cursor was already restored synchronously at mount; touching it here would race
          // a stream that has since advanced past it and duplicate the delta.
        } else {
          if (kept) releaseTerminal(sessionId);
          const preset = activeTerminalTheme();
          terminal = new Terminal({
            convertEol: false,
            cursorBlink: true,
            fontFamily: TERMINAL_FONT_FAMILY,
            fontSize: 13,
            // xterm's own default, and it belongs here: screen reader mode mirrors the viewport
            // into live DOM and does per-line work as output arrives. On top of the DOM renderer,
            // with an agent streaming thousands of lines, that is what made scrolling stutter.
            screenReaderMode: false,
            // The DOM renderer, deliberately — see SessionTerminal.tsx for the WebGL/IME note.
            ...windowsPtyOption(host),
            // Matches the read-only log's scrollback (terminalLogInstances.ts) so switching
            // between the live pane and the log never loses history one has and the other lost.
            scrollback: 10000,
            theme: preset.theme,
            minimumContrastRatio: preset.minimumContrastRatio,
          });
          fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);
          terminal.open(hostRef.current);
          // Registered ONCE for the emulator's life: xterm stacks link providers, and terminals
          // outlive the component, so registering per mount would underline every span N times.
          const providers: IDisposable[] = [
            attachSourceLinks(terminal, (location, text) => {
              retainedTerminal(sessionId)?.pane?.onSourceLocation(location, text);
            }),
          ];
          const clipboardAddon = new ClipboardAddon(
            undefined,
            createOsc52ClipboardProvider(
              undefined,
              (notice) => retainedTerminal(sessionId)?.pane?.onClipboardNotice(notice),
              (message) => retainedTerminal(sessionId)?.pane?.onClipboardError(message),
            ),
          );
          terminal.loadAddon(clipboardAddon);
          providers.push(clipboardAddon);
          retainTerminal(sessionId, {
            terminal,
            fitAddon,
            runId: currentRunId,
            cursor: 0,
            providers,
            pane: null,
          });
        }

        // The callbacks a provider registered once for the emulator's life calls into. Bound on
        // every mount (new terminal or reused) so a returning pane's activations reach it, and
        // unbound on teardown — unbindRetainedPane only clears them when they are still this
        // mount's, so a newer mount racing the same teardown keeps its own.
        const pane: RetainedPaneCallbacks = {
          onSourceLocation: (location, text) => void openLocation(location, text),
          onClipboardNotice: handleClipboardNotice,
          onClipboardError: (message) => setError(message),
        };
        bindRetainedPane(sessionId, pane);

        // Disposed on teardown: the terminal is retained across page switches, so a DOM paste
        // listener left behind would stack and paste once per past mount.
        const detachClipboard = attachTerminalClipboard(
          terminal,
          platformFromUserAgent(navigator.userAgent),
          undefined,
          setError,
          handleClipboardNotice,
        );
        terminalRef.current = terminal;
        const output = createTerminalOutputWriter(
          (bytes, done) => terminal.write(bytes, done),
          (suppressed) => {
            if (suppressed) protocolInputSuppressedSessions.add(sessionId);
            else protocolInputSuppressedSessions.delete(sessionId);
          },
        );
        const enqueueOutput = output.write;
        outputWriterRef.current = enqueueOutput;
        const sendInput = terminal.onData((data) => {
          if (protocolInputSuppressedSessions.has(sessionId)) return;
          const current = runtimeStatusRef.current;
          if (!current || current.phase !== "running" || current.runId === null) return;
          const token = beginRuntimeOperation(runtimeOperationsRef.current, "write", current);
          void sendSessionInput(sessionId, current, data, (cause) => {
            if (
              runtimeOperationBelongsToCurrentRuntime(
                runtimeOperationsRef.current,
                token,
                runtimeStatusRef.current,
              )
            ) {
              reportRuntimeFault("write", cause);
            }
          });
        });
        for (const pending of pendingOutputRef.current.splice(0)) {
          void enqueueOutput(pending.bytes, pending.suppressProtocolInput).then(
            pending.resolve,
            pending.reject,
          );
        }

        // Coalesced to one PTY resize per ~120ms of settled size, not one per changed frame: a
        // split drag fires onResize on every intermediate cols/rows, and forwarding each as its
        // own RPC spammed SIGWINCH into the child and could duplicate lines mid-drag. The check
        // re-reads the runtime status at FIRE time, not at the resize event, so a run that
        // finished or restarted during the debounce window is never sent a stale size.
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        let latestSize: { cols: number; rows: number } | null = null;
        const fireResize = () => {
          resizeTimer = undefined;
          const size = latestSize;
          const current = runtimeStatusRef.current;
          if (!size || !current || current.phase !== "running" || current.runId === null) return;
          const runId = current.runId;
          const token = beginRuntimeOperation(runtimeOperationsRef.current, "resize", current);
          void enqueueRuntimeMutation(
            runtimeMutationQueue,
            JSON.stringify([sessionId, runId, "resize"]),
            async () => {
              await sessionClient.resize(sessionId, runId, size.cols, size.rows);
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
        };
        const sendResize = terminal.onResize(({ cols, rows }) => {
          latestSize = { cols, rows };
          if (resizeTimer !== undefined) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(fireResize, 120);
        });

        const fitter = createTerminalFitter(
          terminal,
          fitAddon,
          () => hostRef.current,
          (cause) => reportRuntimeFault("attach", cause),
          () => clearRuntimeFault("attach"),
        );
        const frame = requestAnimationFrame(() => {
          fitter.schedule();
          if (focusedRef.current && canMoveTerminalFocus()) terminal.focus();
        });
        const observer = new ResizeObserver(fitter.schedule);
        observer.observe(hostRef.current);

        // Reading history while a program owns the mouse (G21): capture-phase wheel/key handling
        // on the pane host, registered under sessionId so the app-wide shortcut layer can toggle
        // it without holding a reference to this mount.
        // The DOM element satisfies ScrollModeHost structurally (addEventListener/removeEventListener);
        // the cast is only for the listener parameter's variance, which TS cannot see through here.
        const scrollHandle = attachScrollMode(
          terminal,
          hostRef.current as unknown as ScrollModeHost,
          setScrollActive,
        );
        const unregisterScrollHandle = registerScrollModeHandle(sessionId, scrollHandle);
        const unwatchViewport = watchTerminalViewport(terminal, setViewport);

        disposeTerminal = () => {
          disposed = true;
          if (outputWriterRef.current === enqueueOutput) outputWriterRef.current = null;
          output.dispose();
          cancelAnimationFrame(frame);
          fitter.dispose();
          observer.disconnect();
          sendInput.dispose();
          sendResize.dispose();
          if (resizeTimer !== undefined) clearTimeout(resizeTimer);
          scrollHandle.dispose();
          unregisterScrollHandle();
          unwatchViewport();
          setScrollActive(false);
          unbindRetainedPane(sessionId, pane);
          detachClipboard();
          // Detach, never dispose: the emulator and its buffer stay retained for this session so
          // the pane returns without replaying. releaseTerminal() is the only place that disposes.
          terminal.element?.remove();
          terminalRef.current = null;
        };
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        terminalAttachFailedRef.current = true;
        for (const pending of pendingOutputRef.current.splice(0)) pending.resolve(false);
        reportRuntimeFault("attach", cause);
      });

    return () => {
      disposed = true;
      for (const pending of pendingOutputRef.current.splice(0)) pending.resolve(false);
      disposeTerminal?.();
    };
    // Deliberately not exhaustive: every other value this effect reads is a ref (refreshed every
    // render by the caller, dereferenced only at call time) or a setState/tracker mutation that
    // does not change identity in a way this effect needs to react to — the same pattern the
    // launch and stream effects in SessionTerminal.tsx already use.
  }, [sessionId, shouldAttachTerminal]);

  return {
    toast,
    scrollActive,
    viewport,
    jumpToBottom: () => {
      jumpTerminalToBottom(sessionId);
    },
    toggleScrollMode: () => {
      toggleTerminalScrollMode(sessionId);
    },
    releaseMouse: () => {
      if (terminalRef.current) resetInteractionModes(terminalRef.current);
    },
  };
}

export function canMoveTerminalFocus(): boolean {
  if (document.querySelector("dialog[open]")) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active.classList.contains("xterm-helper-textarea")) return true;
  return !(active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
}
