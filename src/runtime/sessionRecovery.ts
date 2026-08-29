import type {
  SessionClient,
  SessionRecoveryCatalog,
  SessionRecoveryRecord,
  SpawnSessionInput,
} from "./sessionClient";
import { sessionClient } from "./sessionClient";

/**
 * Mirrors the native store's current bounds. This describes retained recovery evidence, not a
 * transcript guarantee: once rotation has happened, older output is no longer recoverable.
 */
export const sessionRecoveryOutputPolicy = {
  kind: "bounded-tail",
  maximumBytes: 8 * 1024 * 1024,
  retainedBytesAfterRotation: 2 * 1024 * 1024,
} as const;

export interface SessionRecoveryInventory {
  /** Native PTY commands exist. False in the responsive browser preview. */
  nativeRuntimeAvailable: boolean;
  /** Whether this native runtime has a writable local app-data store. */
  persistence: "available" | "unavailable";
  sessions: SessionRecoveryRecord[];
  outputPolicy: typeof sessionRecoveryOutputPolicy;
}

export interface RecoveredSessionOutput {
  sessionId: string;
  /** Raw terminal bytes, oldest retained byte first. The beginning may not be the process start. */
  bytes: Uint8Array;
  retention: typeof sessionRecoveryOutputPolicy.kind;
}

export interface PreparedSessionRecovery {
  record: SessionRecoveryRecord;
  output: RecoveredSessionOutput;
  relaunch: SpawnSessionInput;
}

export type SessionRecoveryClient = Pick<
  SessionClient,
  "available" | "recoveryCatalog" | "readStoredOutput"
>;

export interface SessionRecoveryService {
  inspect: () => Promise<SessionRecoveryInventory>;
  readOutput: (sessionId: string) => Promise<RecoveredSessionOutput>;
  /** Read the old output before relaunching: spawning the same id replaces its stored run. */
  prepare: (record: SessionRecoveryRecord) => Promise<PreparedSessionRecovery>;
}

export function createSessionRecoveryService(
  client: SessionRecoveryClient,
): SessionRecoveryService {
  const readOutput = async (sessionId: string): Promise<RecoveredSessionOutput> => {
    const bytes = await client.readStoredOutput(sessionId);
    return {
      sessionId,
      bytes: Uint8Array.from(bytes),
      retention: sessionRecoveryOutputPolicy.kind,
    };
  };

  return {
    async inspect() {
      const catalog = await client.recoveryCatalog();
      return inventoryFromCatalog(client.available(), catalog);
    },
    readOutput,
    async prepare(record) {
      return {
        record,
        output: await readOutput(record.sessionId),
        relaunch: recoverySpawnInput(record),
      };
    },
  };
}

/** A relaunch request under the same id; no claim is made that the old process survived. */
export function recoverySpawnInput(record: SessionRecoveryRecord): SpawnSessionInput {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    command: record.command,
    args: [...record.args],
    cols: record.cols,
    rows: record.rows,
  };
}

export const sessionRecoveryService = createSessionRecoveryService(sessionClient);

function inventoryFromCatalog(
  nativeRuntimeAvailable: boolean,
  catalog: SessionRecoveryCatalog,
): SessionRecoveryInventory {
  return {
    nativeRuntimeAvailable,
    persistence: catalog.persisted ? "available" : "unavailable",
    sessions: catalog.sessions,
    outputPolicy: sessionRecoveryOutputPolicy,
  };
}
