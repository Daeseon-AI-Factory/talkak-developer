import type { DevSession, LaunchProfile } from "./domain";
import type { LocalizedText } from "./localizedText";

export interface CreateWorkspaceSessionInput {
  id: string;
  title: LocalizedText;
  profile: LocalizedText;
  launchProfile: LaunchProfile;
  branch: string;
  createdAt: string;
  lastActivity: LocalizedText;
  intro: LocalizedText | null;
  outcome: LocalizedText;
  nextStep: LocalizedText;
  launchRequested: boolean;
}

export function createWorkspaceSession(input: CreateWorkspaceSessionInput): DevSession {
  return {
    id: input.id,
    title: input.title,
    profile: input.profile,
    launchProfile: {
      ...input.launchProfile,
      args: [...input.launchProfile.args],
    },
    launchRequested: input.launchRequested,
    state: "idle",
    runtime: { kind: "unconfigured", label: input.profile, shell: "—" },
    runtimeStatus: null,
    branch: input.branch,
    startedAt: input.createdAt,
    lastActivity: input.lastActivity,
    lines: input.intro ? [{ id: `${input.id}-intro`, tone: "muted", text: input.intro }] : [],
    conversation: [],
    summary: {
      outcome: input.outcome,
      progress: 0,
      changedFiles: [],
      decisions: [],
      nextStep: input.nextStep,
    },
  };
}
