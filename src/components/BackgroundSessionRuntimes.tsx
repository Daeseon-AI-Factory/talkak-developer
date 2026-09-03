import type { Project, TerminalRuntimeObservation } from "../domain";
import { SessionTerminal } from "./SessionTerminal";

interface BackgroundSessionRuntimesProps {
  projects: readonly Project[];
  foregroundSessionIds: ReadonlySet<string>;
  onLaunchHandled: (sessionId: string) => void;
  onRuntimeObservation: (sessionId: string, observation: TerminalRuntimeObservation) => void;
}

const ignoreRuntimeAttachment = () => {};

export function BackgroundSessionRuntimes({
  projects,
  foregroundSessionIds,
  onLaunchHandled,
  onRuntimeObservation,
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
            onRuntimeObservation={onRuntimeObservation}
          />
        )),
    );
}
