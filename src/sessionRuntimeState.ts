import type {
  DevSession,
  Project,
  RuntimeTarget,
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
  let changed = false;
  const next = projects.map((project) => {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return project;
    const updated = applyRuntimeObservation(session, observation);
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

export function applyRuntimeObservation(
  session: DevSession,
  observation: TerminalRuntimeObservation,
): DevSession {
  const currentStatus = session.runtimeStatus ?? null;
  if (!shouldApplyRuntimeObservation(currentStatus, observation)) return session;

  const runtimeStatus = statusFromObservation(observation);
  const runtime = isAttachedPhase(observation.phase) ? attachedRuntime(session) : session.runtime;
  if (sameRuntimeStatus(currentStatus, runtimeStatus) && session.runtime === runtime) {
    return session;
  }

  return { ...session, runtime, runtimeStatus };
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
