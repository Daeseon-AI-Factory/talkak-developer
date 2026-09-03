/**
 * One frame of the terminal output stream, as the native side encodes it.
 *
 * The layout is fixed in `src-tauri/src/session_stream.rs` (little-endian):
 *
 *   0  u8   version
 *   1  u8   flags
 *   2  u64  runId
 *   10 u64  start   — engine cursor the payload begins at
 *   18 u64  next    — engine cursor after the payload
 *   26 u32  exitCode (with FLAG_HAS_EXIT_CODE)
 *   30 u16  message length
 *   32 …    message (UTF-8), then the raw PTY bytes
 *
 * Bytes, not JSON: a frame arrives as an ArrayBuffer and the payload is handed to xterm as a view
 * over it, so the hot path copies nothing and parses a 32-byte header.
 */
export interface SessionStreamFrame {
  runId: number;
  start: number;
  next: number;
  bytes: Uint8Array;
  truncated: boolean;
  running: boolean;
  exitCode: number | null;
  readClosed: boolean;
  /** No further frame follows on this stream. */
  ended: boolean;
  /** The broker's read error, or why the stream ended early; null when all is well. */
  error: string | null;
}

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 32;
const FLAG_RUNNING = 1 << 0;
const FLAG_TRUNCATED = 1 << 1;
const FLAG_READ_CLOSED = 1 << 2;
const FLAG_HAS_EXIT_CODE = 1 << 3;
const FLAG_ENDED = 1 << 4;
const FLAG_ERROR = 1 << 5;

const utf8 = new TextDecoder();

export function decodeSessionFrame(buffer: ArrayBuffer): SessionStreamFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`session frame too short: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) {
    throw new Error(`unsupported session frame version ${version}`);
  }
  const flags = view.getUint8(1);
  const messageLength = view.getUint16(30, true);
  if (buffer.byteLength < FRAME_HEADER_BYTES + messageLength) {
    throw new Error("session frame message runs past the frame");
  }
  const message =
    messageLength > 0 ? utf8.decode(new Uint8Array(buffer, FRAME_HEADER_BYTES, messageLength)) : "";
  return {
    runId: Number(view.getBigUint64(2, true)),
    start: Number(view.getBigUint64(10, true)),
    next: Number(view.getBigUint64(18, true)),
    bytes: new Uint8Array(buffer, FRAME_HEADER_BYTES + messageLength),
    truncated: (flags & FLAG_TRUNCATED) !== 0,
    running: (flags & FLAG_RUNNING) !== 0,
    exitCode: (flags & FLAG_HAS_EXIT_CODE) !== 0 ? view.getUint32(26, true) : null,
    readClosed: (flags & FLAG_READ_CLOSED) !== 0,
    ended: (flags & FLAG_ENDED) !== 0,
    error: (flags & FLAG_ERROR) !== 0 ? message : null,
  };
}
