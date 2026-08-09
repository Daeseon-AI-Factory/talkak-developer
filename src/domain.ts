export type AppSection = "workspace" | "sessions" | "activity" | "attention" | "settings";

export type InspectorMode = "summary" | "conversation";

export type PaneLayout = "columns" | "rows";

export type SidebarMode = "expanded" | "rail" | "hidden";

export type SessionState = "working" | "needs-input" | "ready" | "idle";

export type AttentionKind = "question" | "approval" | "result" | "error";

export type AttentionRisk = "low" | "medium" | "high";

export type AttentionStatus = "open" | "resolved";

export type ProjectSource = "preview" | "local";

export interface LaunchProfile {
  label: string;
  command: string | null;
  args: string[];
}

export interface AttentionChoice {
  id: string;
  label: string;
  description?: string;
}

export interface AttentionResolution {
  choiceId: string;
  resolvedAt: string;
}

export interface AttentionRequest {
  id: string;
  projectId: string;
  sessionId: string;
  kind: AttentionKind;
  risk: AttentionRisk;
  title: string;
  description: string;
  choices: AttentionChoice[];
  createdAt: string;
  status: AttentionStatus;
  revision: number;
  resolution: AttentionResolution | null;
}

export type RuntimeTarget =
  | {
      kind: "unconfigured";
      label: string;
      shell: "—";
    }
  | {
      kind: "native";
      os: "macos" | "windows";
      label: string;
      shell: string;
    }
  | {
      kind: "wsl";
      os: "windows";
      label: string;
      distribution: string;
      shell: string;
    };

export interface TerminalLine {
  id: string;
  tone: "command" | "muted" | "success" | "agent" | "warning";
  text: string;
}

export interface ConversationEntry {
  id: string;
  author: "you" | "agent" | "system";
  time: string;
  text: string;
}

export interface SessionSummary {
  outcome: string;
  progress: number;
  changedFiles: string[];
  decisions: string[];
  nextStep: string;
}

export interface DevSession {
  id: string;
  title: string;
  profile: string;
  launchProfile: LaunchProfile;
  state: SessionState;
  runtime: RuntimeTarget;
  branch: string;
  startedAt: string;
  lastActivity: string;
  lines: TerminalLine[];
  conversation: ConversationEntry[];
  summary: SessionSummary;
}

export interface Project {
  id: string;
  source: ProjectSource;
  name: string;
  monogram: string;
  color: string;
  path: string;
  branch: string;
  description: string;
  launchProfile: LaunchProfile;
  sessions: DevSession[];
}
