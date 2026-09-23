import { invoke, isTauri } from "@tauri-apps/api/core";

export interface HostInfo {
  os: string;
  architecture: string;
  supportsWslDiscovery: boolean;
  /** The Windows build, or null off Windows. */
  windowsBuild: number | null;
}

/**
 * What the app is running on, asked once.
 *
 * The build number is not in the user agent, and xterm needs it: told it is driving a ConPTY, it
 * uses the right buffer heuristics; left to guess, a growing pane pulls lines back out of
 * scrollback instead of appending blank rows, so content duplicates and the viewport moves.
 *
 * Cached because the answer cannot change while the app runs, and every pane would otherwise ask.
 */
let pending: Promise<HostInfo | null> | null = null;

export function hostInfo(): Promise<HostInfo | null> {
  if (pending) return pending;
  pending = isTauri() ? invoke<HostInfo>("host_info").catch(() => null) : Promise.resolve(null);
  return pending;
}

/** Test seam: the cache is module state. */
export function resetHostInfo(): void {
  pending = null;
}

/**
 * The xterm option describing the pty behind this terminal, or nothing when that is not knowable.
 * Kept pure so the decision is testable without a host.
 */
export function windowsPtyOption(
  host: HostInfo | null,
): { windowsPty: { backend: "conpty"; buildNumber: number } } | Record<string, never> {
  if (!host || host.os !== "windows" || host.windowsBuild === null) return {};
  // portable-pty uses ConPTY on Windows; winpty is not a path this product takes.
  return { windowsPty: { backend: "conpty", buildNumber: host.windowsBuild } };
}

/**
 * Opening a `path:line` reference clicked in a terminal. The Rust side resolves the path against
 * the session's cwd, refuses anything outside the cwd or the project root, and launches the
 * user-configured editor — or the OS default app when none is set (law 1: the editor is a
 * per-device setting, never a code default).
 */
export interface OpenSourceLocationRequest {
  cwd: string;
  projectRoot: string;
  path: string;
  line: number;
  column?: number;
  editorCommand: string | null;
  editorArgsTemplate: string[] | null;
}

export type OpenSourceLocationFailureKind =
  | "notFound"
  | "notAFile"
  | "outsideWorkspace"
  | "editorNotFound"
  | "editorFailed"
  | "unavailable"
  | "openFailed";

export interface OpenSourceLocationFailure {
  kind: OpenSourceLocationFailureKind;
  detail: string;
}

const OPEN_SOURCE_LOCATION_FAILURE_KINDS: readonly OpenSourceLocationFailureKind[] = [
  "notFound",
  "notAFile",
  "outsideWorkspace",
  "editorNotFound",
  "editorFailed",
  "unavailable",
  "openFailed",
];

function isOpenSourceLocationFailureKind(value: unknown): value is OpenSourceLocationFailureKind {
  return (
    typeof value === "string" &&
    (OPEN_SOURCE_LOCATION_FAILURE_KINDS as readonly string[]).includes(value)
  );
}

/** Exported for tests: the Rust command's error, browser-preview unavailability, and every other
 * transport failure all normalize to the same shape here. */
export function normalizeOpenSourceLocationFailure(cause: unknown): OpenSourceLocationFailure {
  if (cause && typeof cause === "object" && "kind" in cause) {
    const { kind } = cause as { kind: unknown };
    if (isOpenSourceLocationFailureKind(kind)) {
      const detail = "detail" in cause ? String((cause as { detail: unknown }).detail ?? "") : "";
      return { kind, detail };
    }
  }
  return { kind: "openFailed", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** Resolves to null on success, or the reason it did not open. */
export async function openSourceLocation(
  request: OpenSourceLocationRequest,
): Promise<OpenSourceLocationFailure | null> {
  if (!isTauri()) return { kind: "unavailable", detail: "" };
  try {
    await invoke("open_source_location", { request });
    return null;
  } catch (cause) {
    return normalizeOpenSourceLocationFailure(cause);
  }
}
