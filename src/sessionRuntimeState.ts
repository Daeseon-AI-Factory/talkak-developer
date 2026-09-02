import type {
  AgentActivity,
  AgentActivityState,
  DevSession,
  Project,
  RuntimeTarget,
  SessionState,
  TerminalRuntimeFault,
  TerminalRuntimeObservation,
  TerminalRuntimePhase,
  TerminalRuntimeStatus,
} from "./domain";

export function applyRuntimeObservationToProjects(
  projects: Project[],
  sessionId: string,
  observation: TerminalRuntimeObservation,
): Project[] {
  return updateSessionInProjects(projects, sessionId, (session) =>
    applyRuntimeObservation(session, observation),
  );
}

export function applyRuntimeObservation(
  session: DevSession,
  observation: TerminalRuntimeObservation,
): DevSession {
  const currentStatus = session.runtimeStatus ?? null;
  if (!shouldApplyRuntimeObservation(currentStatus, observation)) return session;

  const runtimeStatus = statusFromObservation(observation);
  const runtime = isAttachedPhase(observation.phase) ? attachedRuntime(session) : session.runtime;
  // The agent record only describes a live PTY. Once the process is gone — or a new run is
  // starting — whatever it last said is history, and a dead pane must not keep reading "Working".
  // Only a state the record produced is cleared; a seeded label is not this function's to change.
  const previousActivity = session.agentActivity ?? null;
  const clearRecord = previousActivity !== null && !isLivePhase(runtimeStatus.phase);
  if (
    sameRuntimeStatus(currentStatus, runtimeStatus) &&
    session.runtime === runtime &&
    !clearRecord
  ) {
    return session;
  }

  return clearRecord
    ? { ...session, runtime, runtimeStatus, agentActivity: null, state: "idle" }
    : { ...session, runtime, runtimeStatus };
}

/**
 * Fold one agent-record reading into a session. Only a live PTY takes it: an exited or errored
 * process keeps precedence, so a record that still says "working" cannot revive a dead pane.
 * `observedAt` stands in for a record without timestamps, and only when the state actually moved,
 * so the same reading polled every second does not look like a new event every second.
 */
export function applyAgentActivity(
  session: DevSession,
  activity: AgentActivity,
  observedAt: string,
): DevSession {
  const phase = session.runtimeStatus?.phase;
  if (phase === undefined || !isLivePhase(phase)) return session;

  const previous = session.agentActivity ?? null;
  const stateChanged = previous === null || previous.state !== activity.state;
  const at = activity.at ?? (stateChanged ? observedAt : (previous?.at ?? observedAt));
  const next: AgentActivity = { state: activity.state, lastTool: activity.lastTool, at };
  const state = sessionStateForAgentActivity(activity.state);
  if (previous && sameAgentActivity(previous, next) && session.state === state) return session;
  return { ...session, state, agentActivity: next };
}

export function applyAgentActivityToProjects(
  projects: Project[],
  sessionId: string,
  activity: AgentActivity,
  observedAt: string,
): Project[] {
  return updateSessionInProjects(projects, sessionId, (session) =>
    applyAgentActivity(session, activity, observedAt),
  );
}

/** The seeded session vocabulary the rest of the UI already styles, from the record's states. */
export function sessionStateForAgentActivity(state: AgentActivityState): SessionState {
  switch (state) {
    case "thinking":
    case "working":
      return "working";
    case "needs-input":
      return "needs-input";
    case "done":
      return "ready";
    default:
      return "idle";
  }
}

export function isLivePhase(phase: TerminalRuntimePhase): boolean {
  return phase === "running" || phase === "stopping";
}

function updateSessionInProjects(
  projects: Project[],
  sessionId: string,
  update: (session: DevSession) => DevSession,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return project;
    const updated = update(session);
    if (updated === session) return project;
    changed = true;
    return {
      ...project,
      sessions: project.sessions.map((candidate) =>
        candidate.id === sessionId ? updated : candidate,
      ),
    };
  });
  return changed ? next : projects;
}

function sameAgentActivity(left: AgentActivity, right: AgentActivity): boolean {
  return left.state === right.state && left.lastTool === right.lastTool && left.at === right.at;
}

export function shouldApplyRuntimeObservation(
  current: TerminalRuntimeStatus | null,
  observation: TerminalRuntimeObservation,
): boolean {
  if (!current) return true;
  if (observation.origin === "explicit-action" && observation.phase === "starting") return true;
  if (current.runId !== null && observation.runId !== null && observation.runId < current.runId) {
    return false;
  }
  if (current.runId !== null && observation.runId !== null && current.runId === observation.runId) {
    if (
      (current.phase === "exited" || current.phase === "error") &&
      isActivePhase(observation.phase)
    ) {
      return false;
    }
    if (
      current.phase === "stopping" &&
      (observation.phase === "starting" || observation.phase === "running")
    ) {
      return false;
    }
  }
  if (
    observation.origin === "passive-probe" &&
    (current.phase === "error" || current.phase === "exited") &&
    (observation.phase === "checking" ||
      observation.phase === "idle" ||
      observation.phase === "unavailable")
  ) {
    return false;
  }
  return true;
}

/** Transitional phase-only bridge. It deliberately does not fabricate runtime observations. */
export function applyRuntimePhase(session: DevSession, phase: TerminalRuntimePhase): DevSession {
  if (phase === "checking" || phase === "starting") return session;

  const state = phase === "running" || phase === "stopping" ? "working" : "idle";
  const runtime = isAttachedPhase(phase) ? attachedRuntime(session) : session.runtime;
  if (session.state === state && session.runtime === runtime) return session;
  return { ...session, state, runtime };
}

function statusFromObservation(observation: TerminalRuntimeObservation): TerminalRuntimeStatus {
  if (observation.origin === "explicit-action" && observation.phase === "starting") {
    return {
      phase: "starting",
      runId: null,
      exitCode: null,
      termination: null,
      fault: null,
      observedAt: observation.observedAt,
    };
  }
  return {
    phase: observation.phase,
    runId: observation.runId,
    exitCode: observation.exitCode,
    termination: observation.termination,
    fault: observation.fault ? { ...observation.fault } : null,
    observedAt: observation.observedAt,
  };
}

function sameRuntimeStatus(
  left: TerminalRuntimeStatus | null,
  right: TerminalRuntimeStatus,
): boolean {
  return (
    left !== null &&
    left.phase === right.phase &&
    left.runId === right.runId &&
    left.exitCode === right.exitCode &&
    left.termination === right.termination &&
    sameFault(left.fault, right.fault)
  );
}

function sameFault(left: TerminalRuntimeFault | null, right: TerminalRuntimeFault | null): boolean {
  if (left === right) return true;
  return (
    left !== null &&
    right !== null &&
    left.operation === right.operation &&
    left.message === right.message
  );
}

function isAttachedPhase(phase: TerminalRuntimePhase): boolean {
  return phase === "running" || phase === "stopping" || phase === "exited";
}

function isActivePhase(phase: TerminalRuntimePhase): boolean {
  return phase === "starting" || phase === "running" || phase === "stopping";
}

function attachedRuntime(session: DevSession): RuntimeTarget {
  const label = session.launchProfile.label || session.profile;
  const shell = session.launchProfile.command || "PTY";
  if (
    session.runtime.kind === "local" &&
    session.runtime.label === label &&
    session.runtime.shell === shell
  ) {
    return session.runtime;
  }
  return { kind: "local", label, shell };
}
