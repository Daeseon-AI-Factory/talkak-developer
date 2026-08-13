import type { DevSession, RuntimeTarget, TerminalRuntimePhase } from "./domain";

export function applyRuntimePhase(session: DevSession, phase: TerminalRuntimePhase): DevSession {
  if (phase === "checking" || phase === "starting") return session;

  const state = phase === "running" || phase === "stopping" ? "working" : "idle";
  const runtime = isAttachedPhase(phase) ? attachedRuntime(session) : session.runtime;
  if (session.state === state && session.runtime === runtime) return session;
  return { ...session, state, runtime };
}

function isAttachedPhase(phase: TerminalRuntimePhase): boolean {
  return phase === "running" || phase === "stopping" || phase === "exited";
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
