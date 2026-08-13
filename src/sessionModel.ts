import type { DevSession, LaunchProfile } from "./domain";

export interface CreateWorkspaceSessionInput {
  id: string;
  title: string;
  profile: string;
  launchProfile: LaunchProfile;
  createdAt: string;
  lastActivity: string;
  intro: string;
  outcome: string;
  nextStep: string;
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
    branch: "main",
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
