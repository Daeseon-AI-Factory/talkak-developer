import type { TerminalRuntimePhase } from "../domain";

export interface TerminalOutputChunk {
  bytes: Uint8Array;
  suppressProtocolInput: boolean;
}

/**
 * Whether a pane keeps an output stream open. A visible pane streams while the run lives and once
 * more after exit, so its last output lands; a background (page-switched) pane only follows a live
 * run — an exited one has nothing left to deliver and its emulator would be kept alive for nothing.
 */
export function terminalStreamEnabled(phase: TerminalRuntimePhase, background: boolean): boolean {
  return phase === "running" || phase === "stopping" || (phase === "exited" && !background);
}

export function terminalRuntimePhase(
  previousPhase: TerminalRuntimePhase,
  running: boolean,
  readError: string | null,
): TerminalRuntimePhase {
  if (readError) return "error";
  if (!running) return "exited";
  return previousPhase === "stopping" ? "stopping" : "running";
}

export function partitionTerminalOutput(
  bytes: Uint8Array,
  start: number,
  replayThrough: number,
): TerminalOutputChunk[] {
  if (bytes.length === 0) return [];
  const replayLength = Math.max(0, Math.min(bytes.length, replayThrough - start));
  if (replayLength === 0) return [{ bytes, suppressProtocolInput: false }];
  if (replayLength === bytes.length) return [{ bytes, suppressProtocolInput: true }];
  return [
    { bytes: bytes.subarray(0, replayLength), suppressProtocolInput: true },
    { bytes: bytes.subarray(replayLength), suppressProtocolInput: false },
  ];
}
