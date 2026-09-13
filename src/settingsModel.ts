export const featureSettingIds = [
  "sessionSummaries",
  "conversationIndexing",
  "attentionDetection",
  "notifications",
  "riskConfirmations",
  "remoteAccess",
  "voiceInput",
] as const;

export type FeatureSettingId = (typeof featureSettingIds)[number];
export type SettingScope = "app" | "project" | "session";
export type FeatureSettingOverrides = Partial<Record<FeatureSettingId, boolean>>;

export interface SettingsState {
  app: FeatureSettingOverrides;
  projects: Record<string, FeatureSettingOverrides>;
  sessions: Record<string, FeatureSettingOverrides>;
}

export interface SettingContext {
  projectId?: string;
  sessionId?: string;
}

export function createDefaultSettingsState(): SettingsState {
  return { app: {}, projects: {}, sessions: {} };
}

export function effectiveSetting(
  state: SettingsState,
  id: FeatureSettingId,
  context: SettingContext = {},
): boolean {
  if (context.sessionId) {
    const sessionValue = state.sessions[context.sessionId]?.[id];
    if (sessionValue !== undefined) return sessionValue;
  }

  if (context.projectId) {
    const projectValue = state.projects[context.projectId]?.[id];
    if (projectValue !== undefined) return projectValue;
  }

  return state.app[id] ?? false;
}

/**
 * Sets one explicit override. Passing null removes it and exposes its parent fallback.
 * App scope requires a null target; project and session scopes require their stable ID.
 */
export function setSettingOverride(
  state: SettingsState,
  scope: SettingScope,
  targetId: string | null,
  id: FeatureSettingId,
  value: boolean | null,
): SettingsState {
  if (scope === "app") {
    if (targetId !== null) throw new RangeError("App setting overrides do not accept a target ID.");
    const app = updateOverrides(state.app, id, value);
    return app === state.app ? state : { ...state, app };
  }

  if (!targetId) throw new RangeError(`${scope} setting overrides require a target ID.`);
  const scopes = scope === "project" ? state.projects : state.sessions;
  const currentOverrides = scopes[targetId] ?? {};
  const nextOverrides = updateOverrides(currentOverrides, id, value);
  if (nextOverrides === currentOverrides) return state;

  const nextScopes = { ...scopes };
  if (Object.keys(nextOverrides).length === 0) delete nextScopes[targetId];
  else nextScopes[targetId] = nextOverrides;

  return scope === "project"
    ? { ...state, projects: nextScopes }
    : { ...state, sessions: nextScopes };
}

function updateOverrides(
  overrides: FeatureSettingOverrides,
  id: FeatureSettingId,
  value: boolean | null,
): FeatureSettingOverrides {
  if (value === null) {
    if (overrides[id] === undefined) return overrides;
    const next = { ...overrides };
    delete next[id];
    return next;
  }

  return overrides[id] === value ? overrides : { ...overrides, [id]: value };
}
