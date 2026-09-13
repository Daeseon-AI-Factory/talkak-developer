import { describe, expect, it, vi } from "vitest";
import {
  type AppUpdateClient,
  type AppUpdateState,
  type AvailableUpdate,
  createAppUpdater,
} from "./appUpdate";

function client(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    available: () => true,
    currentVersion: async () => "0.1.0",
    check: async () => null,
    relaunch: async () => undefined,
    ...overrides,
  };
}

function release(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    currentVersion: "0.1.0",
    version: "0.2.0",
    body: "faster terminal",
    downloadAndInstall: async (onProgress) => {
      onProgress({ event: "Started", data: { contentLength: 10 } });
      onProgress({ event: "Progress", data: { chunkLength: 4 } });
      onProgress({ event: "Progress", data: { chunkLength: 6 } });
      onProgress({ event: "Finished" });
    },
    ...overrides,
  };
}

describe("app updater", () => {
  it("is honest about the browser preview", async () => {
    const updater = createAppUpdater(client({ available: () => false }));
    expect(updater.state()).toEqual({ kind: "unsupported" });
    await expect(updater.check()).resolves.toEqual({ kind: "unsupported" });
  });

  it("reports an up-to-date install with the time it checked", async () => {
    const updater = createAppUpdater(client());
    const seen: AppUpdateState["kind"][] = [];
    updater.subscribe((state) => seen.push(state.kind));

    const state = await updater.check();

    expect(state.kind).toBe("current");
    if (state.kind === "current") expect(state.currentVersion).toBe("0.1.0");
    expect(seen).toEqual(["checking", "current"]);
  });

  it("offers an available release, then installs it with progress and relaunches", async () => {
    const relaunch = vi.fn(async () => undefined);
    const updater = createAppUpdater(client({ check: async () => release(), relaunch }));
    const progress: number[] = [];
    updater.subscribe((state) => {
      if (state.kind === "installing") progress.push(state.downloadedBytes);
    });

    const offered = await updater.check();
    expect(offered).toEqual({
      kind: "available",
      currentVersion: "0.1.0",
      version: "0.2.0",
      notes: "faster terminal",
    });

    const done = await updater.install();
    expect(done).toEqual({ kind: "installed", version: "0.2.0" });
    expect(progress).toEqual([0, 0, 4, 10, 10]);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("turns a failed check or install into a state, never an exception", async () => {
    const offline = createAppUpdater(
      client({
        check: async () => {
          throw new Error("offline");
        },
      }),
    );
    await expect(offline.check()).resolves.toEqual({
      kind: "failed",
      currentVersion: "0.1.0",
      message: "offline",
    });

    const broken = createAppUpdater(
      client({
        check: async () =>
          release({
            downloadAndInstall: async () => {
              throw new Error("signature mismatch");
            },
          }),
      }),
    );
    await broken.check();
    await expect(broken.install()).resolves.toEqual({
      kind: "failed",
      currentVersion: "0.1.0",
      message: "signature mismatch",
    });
  });

  it("ignores an install request when nothing is available and coalesces checks", async () => {
    let checks = 0;
    const updater = createAppUpdater(
      client({
        check: async () => {
          checks += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return null;
        },
      }),
    );
    expect((await updater.install()).kind).toBe("idle");
    await Promise.all([updater.check(), updater.check()]);
    expect(checks).toBe(1);
  });
});
