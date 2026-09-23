import type { LaunchProfile } from "../domain";
import type { SpawnSessionInput } from "./sessionClient";

// Exact initial terminal size for a new pane, not a product guarantee.
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

export function hasMemoryConnection(profile: LaunchProfile): boolean {
  return hasAgentConnection(profile) && profile.memoryEnabled !== false;
}

export function hasAgentConnection(profile: LaunchProfile): boolean {
  return Boolean(profile.command?.trim() && profile.memory);
}

export function createSessionSpawnInput(
  sessionId: string,
  cwd: string,
  profile: LaunchProfile,
): SpawnSessionInput {
  const command = profile.command?.trim() || null;
  return {
    sessionId,
    cwd: cwd.trim() || null,
    command,
    args: command ? [...profile.args] : [],
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    ...(hasAgentConnection(profile)
      ? {
          memory: profile.memory,
          ...(profile.memoryEnabled === false ? { memoryEnabled: false } : {}),
        }
      : {}),
  };
}
