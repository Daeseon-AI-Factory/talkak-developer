import type { LaunchProfile } from "../domain";
import type { SpawnSessionInput } from "./sessionClient";

// Exact initial terminal size for a new pane, not a product guarantee.
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

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
  };
}
