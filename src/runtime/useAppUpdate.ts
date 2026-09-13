import { useEffect, useState } from "react";
import { type AppUpdateState, type AppUpdater, appUpdater } from "./appUpdate";

/**
 * The updater's state as React sees it. One launch-time check per process — not per mount — so
 * opening Settings twice does not ask the feed twice; a person can still ask explicitly.
 */
let launchCheckStarted = false;

export function useAppUpdate(updater: AppUpdater = appUpdater): {
  state: AppUpdateState;
  check: () => Promise<AppUpdateState>;
  install: () => Promise<AppUpdateState>;
} {
  const [state, setState] = useState<AppUpdateState>(updater.state());

  useEffect(() => updater.subscribe(setState), [updater]);

  useEffect(() => {
    if (launchCheckStarted || updater.state().kind === "unsupported") return;
    launchCheckStarted = true;
    void updater.check();
  }, [updater]);

  return { state, check: updater.check, install: updater.install };
}

/** Test seam: the launch check is process-wide state. */
export function resetLaunchCheck(): void {
  launchCheckStarted = false;
}
