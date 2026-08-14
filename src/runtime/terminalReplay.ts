import type { TerminalRuntimePhase } from "../domain";

export interface TerminalOutputChunk {
  bytes: Uint8Array;
  suppressProtocolInput: boolean;
}

export function terminalPollingEnabled(phase: TerminalRuntimePhase, background: boolean): boolean {
  return phase === "running" || phase === "stopping" || (phase === "exited" && !background);
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
    { bytes: bytes.slice(0, replayLength), suppressProtocolInput: true },
    { bytes: bytes.slice(replayLength), suppressProtocolInput: false },
  ];
}
