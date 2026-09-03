import { useSyncExternalStore } from "react";

/**
 * The editor a click on a `path:line` link launches. A per-device setting, never a product
 * default (law 1) — `command: null` means "let the OS decide", which is what a clean install
 * gets with nothing configured. Persisted the same way as the terminal theme: this browser's
 * storage only, applied live to every subsequent open.
 */
export interface TerminalEditorSetting {
  /** null = OS default app for the file. A trimmed, non-empty string names the editor binary. */
  command: string | null;
  /** {file} {line} {column} placeholders; empty means "just the file path". */
  argsTemplate: string[];
}

const STORAGE_KEY = "talkak.terminalEditor";
const DEFAULT_SETTING: TerminalEditorSetting = { command: null, argsTemplate: [] };

function readStoredSetting(): TerminalEditorSetting {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTING;
    const parsed = JSON.parse(raw) as Partial<TerminalEditorSetting> | null;
    const command =
      typeof parsed?.command === "string" && parsed.command.trim() ? parsed.command : null;
    const argsTemplate = Array.isArray(parsed?.argsTemplate)
      ? parsed.argsTemplate.filter((item): item is string => typeof item === "string")
      : [];
    return { command, argsTemplate };
  } catch {
    return DEFAULT_SETTING;
  }
}

let active: TerminalEditorSetting | null = null;
const listeners = new Set<(setting: TerminalEditorSetting) => void>();

export function activeTerminalEditorSetting(): TerminalEditorSetting {
  if (!active) active = readStoredSetting();
  return active;
}

export function setTerminalEditorSetting(setting: TerminalEditorSetting): void {
  active = setting;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setting));
  } catch {
    // The choice still applies for this run when storage is unavailable.
  }
  for (const listener of listeners) listener(setting);
}

export function subscribeTerminalEditorSetting(
  listener: (setting: TerminalEditorSetting) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active setting as React state: re-renders when the choice changes. */
export function useTerminalEditorSetting(): TerminalEditorSetting {
  return useSyncExternalStore(
    subscribeTerminalEditorSetting,
    activeTerminalEditorSetting,
    activeTerminalEditorSetting,
  );
}

/** Test seam: forget the cached choice so the next read consults storage again. */
export function resetTerminalEditorSettingCache(): void {
  active = null;
}
