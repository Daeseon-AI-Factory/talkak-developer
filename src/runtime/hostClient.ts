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
