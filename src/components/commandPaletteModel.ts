import type { DevSession, Project } from "../domain";
import type { LocalizedText } from "../localizedText";
import { sessionAcceptsInput } from "../runtime/sessionInput";

/**
 * What the palette lists for a query. Pure, so the two modes — searching projects and sessions,
 * and typing a line into the active session — can be tested without rendering.
 */

/** The prefix that turns the palette into a typing surface for the active session. */
export const DISPATCH_PREFIX = ">";

export type PaletteEntry =
  | { kind: "project"; project: Project }
  | { kind: "session"; project: Project; session: DevSession }
  /** Type `text` into the active session's PTY. `enabled` is false when nothing can take it. */
  | { kind: "dispatch"; text: string; sessionTitle: LocalizedText | null; enabled: boolean };

export interface PaletteModel {
  mode: "search" | "dispatch";
  /** Projects with their sessions filtered to the query; empty in dispatch mode. */
  results: Project[];
  entries: PaletteEntry[];
}

/**
 * The raw line behind a `>` query, or null when the query is not a dispatch. One leading space is
 * the natural way to write `> make test`, so it goes; anything after that is the user's, spaces
 * and all — a raw dispatch is typed, not interpreted.
 */
export function dispatchText(query: string): string | null {
  if (!query.startsWith(DISPATCH_PREFIX)) return null;
  const raw = query.slice(DISPATCH_PREFIX.length);
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

export function paletteModel(
  projects: readonly Project[],
  query: string,
  activeSession: DevSession | null,
  text: (value: LocalizedText) => string,
): PaletteModel {
  const dispatch = dispatchText(query);
  if (dispatch !== null) {
    const enabled = activeSession !== null && sessionAcceptsInput(activeSession.runtimeStatus);
    return {
      mode: "dispatch",
      results: [],
      entries: [
        {
          kind: "dispatch",
          text: dispatch,
          sessionTitle: activeSession?.title ?? null,
          enabled,
        },
      ],
    };
  }

  const normalized = query.trim().toLocaleLowerCase();
  const results = normalized
    ? projects
        .map((project) => ({
          ...project,
          sessions: project.sessions.filter((session) =>
            [text(session.title), text(session.profile), session.branch, project.name]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalized),
          ),
        }))
        .filter(
          (project) =>
            project.name.toLocaleLowerCase().includes(normalized) || project.sessions.length > 0,
        )
    : [...projects];
  return {
    mode: "search",
    results,
    entries: results.flatMap((project): PaletteEntry[] => [
      { kind: "project", project },
      ...project.sessions.map((session): PaletteEntry => ({ kind: "session", project, session })),
    ]),
  };
}
