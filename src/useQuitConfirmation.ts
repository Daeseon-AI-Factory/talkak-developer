import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { type SessionKill, runningSessionKills } from "./appQuit";
import type { Project } from "./domain";

/**
 * The window X asks before anything dies. `projects` is read through a ref because the close
 * handler is registered once with the OS and must see current state, not its mount-time snapshot.
 */
export function useQuitConfirmation(projects: readonly Project[]) {
  const [quitKills, setQuitKills] = useState<SessionKill[] | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Always take over the close: quitting goes through app_quit so no window-destroy
        // permission is involved, and an accidental X never silently strands running agents.
        event.preventDefault();
        const kills = runningSessionKills(projectsRef.current);
        if (kills.length === 0) {
          void invoke("app_quit", { kills: [] });
          return;
        }
        setQuitKills(kills);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { quitKills, setQuitKills };
}
