import type { Project, TerminalRuntimePhase } from "../domain";
import { SessionTerminal } from "./SessionTerminal";

interface BackgroundSessionRuntimesProps {
  projects: readonly Project[];
  foregroundSessionIds: ReadonlySet<string>;
  onLaunchHandled: (sessionId: string) => void;
  onPhaseChange: (sessionId: string, phase: TerminalRuntimePhase) => void;
}

const ignoreRuntimeAttachment = () => {};

export function BackgroundSessionRuntimes({
  projects,
  foregroundSessionIds,
  onLaunchHandled,
  onPhaseChange,
}: BackgroundSessionRuntimesProps) {
  return projects
    .filter((project) => project.source === "local")
    .flatMap((project) =>
      project.sessions
        .filter((session) => !foregroundSessionIds.has(session.id))
        .map((session) => (
          <SessionTerminal
            key={session.id}
            session={session}
            projectPath={project.path}
            focused={false}
            background
            onRuntimeAttached={ignoreRuntimeAttachment}
            onLaunchHandled={onLaunchHandled}
            onPhaseChange={onPhaseChange}
          />
        )),
    );
}
