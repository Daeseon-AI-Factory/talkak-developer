import type { LocalizedText } from "./localizedText";

/**
 * The title a session takes when someone names it. A typed name is kept verbatim; clearing the
 * field hands the session back its generated "Session N" title rather than leaving it blank, so
 * emptying the box is the way out rather than a dead end.
 */
export function renamedSessionTitle(name: string, index: number): LocalizedText {
  const trimmed = name.trim();
  return trimmed || { kind: "session-title", index };
}
