import { describe, expect, it } from "vitest";
import { FRAME_HEADER_BYTES, decodeSessionFrame } from "./sessionFrame";

function frame(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe("decodeSessionFrame", () => {
  it("decodes the byte fixture pinned by src-tauri/src/session_stream.rs", () => {
    // frame_layout_is_pinned: runId 7, start 1000, next 1006, running + truncated, payload "hi\e[0m".
    const decoded = decodeSessionFrame(
      frame([
        1, 3, 7, 0, 0, 0, 0, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0, 238, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 104, 105, 27, 91, 48, 109,
      ]),
    );
    expect(decoded).toMatchObject({
      runId: 7,
      start: 1000,
      next: 1006,
      truncated: true,
      running: true,
      exitCode: null,
      readClosed: false,
      ended: false,
      error: null,
    });
    expect(new TextDecoder().decode(decoded.bytes)).toBe("hi\u001b[0m");
  });

  it("carries an exit, an error message, and the end of the stream in the header", () => {
    const message = new TextEncoder().encode("pty gone");
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setUint8(0, 1);
    // truncated | readClosed | hasExitCode | ended | error
    view.setUint8(1, 2 | 4 | 8 | 16 | 32);
    view.setBigUint64(2, 9n, true);
    view.setBigUint64(10, 500n, true);
    view.setBigUint64(18, 500n, true);
    view.setUint32(26, 130, true);
    view.setUint16(30, message.length, true);
    const decoded = decodeSessionFrame(
      frame([...header, ...message, ...new TextEncoder().encode("tail")]),
    );
    expect(decoded).toMatchObject({
      runId: 9,
      start: 500,
      next: 500,
      running: false,
      truncated: true,
      readClosed: true,
      exitCode: 130,
      ended: true,
      error: "pty gone",
    });
    expect(new TextDecoder().decode(decoded.bytes)).toBe("tail");
  });

  it("refuses a frame it cannot trust rather than feeding xterm garbage", () => {
    expect(() => decodeSessionFrame(frame([1, 0, 0]))).toThrow(/too short/);
    const wrongVersion = new Uint8Array(FRAME_HEADER_BYTES);
    wrongVersion[0] = 2;
    expect(() => decodeSessionFrame(wrongVersion.buffer)).toThrow(/version/);
    const overrun = new Uint8Array(FRAME_HEADER_BYTES);
    overrun[0] = 1;
    new DataView(overrun.buffer).setUint16(30, 4, true);
    expect(() => decodeSessionFrame(overrun.buffer)).toThrow(/runs past/);
  });
});
