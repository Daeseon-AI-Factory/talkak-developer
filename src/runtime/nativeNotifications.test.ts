import { describe, expect, it, vi } from "vitest";
import {
  type NativeNotifierBridge,
  createNativeNotifier,
  planNativeNotifications,
} from "./nativeNotifications";
import type { RuntimeAttentionNotice } from "./runtimeAttentionModel";

function bridge(overrides: Partial<NativeNotifierBridge> = {}): NativeNotifierBridge {
  return {
    available: () => true,
    webviewPermission: () => "default",
    isPermissionGranted: async () => false,
    requestPermission: async () => "granted",
    sendNotification: () => {},
    ...overrides,
  };
}

describe("native notifier permission", () => {
  it("reports unavailable outside the desktop shell instead of pretending", async () => {
    const notifier = createNativeNotifier(bridge({ available: () => false }));
    expect(await notifier.permission()).toBe("unavailable");
    expect(await notifier.request()).toBe("unavailable");
    expect(await notifier.send("t", "b")).toBe(false);
  });

  it("trusts the webview's own granted or denied answer", async () => {
    expect(
      await createNativeNotifier(bridge({ webviewPermission: () => "granted" })).permission(),
    ).toBe("granted");
    expect(
      await createNativeNotifier(bridge({ webviewPermission: () => "denied" })).permission(),
    ).toBe("denied");
  });

  it("asks the plugin when the webview has not decided, and calls an unanswered ask a prompt", async () => {
    const notifier = createNativeNotifier(bridge());
    expect(await notifier.permission()).toBe("prompt");
    expect(await notifier.request()).toBe("granted");
  });

  it("calls a refused request denied from then on", async () => {
    const notifier = createNativeNotifier(bridge({ requestPermission: async () => "denied" }));
    expect(await notifier.request()).toBe("denied");
    expect(await notifier.permission()).toBe("denied");
  });

  it("treats a throwing plugin as unavailable rather than granted", async () => {
    const notifier = createNativeNotifier(
      bridge({
        webviewPermission: () => null,
        isPermissionGranted: async () => {
          throw new Error("no plugin");
        },
      }),
    );
    expect(await notifier.permission()).toBe("unavailable");
  });
});

describe("native notifier send", () => {
  it("requests permission on first send and then delivers", async () => {
    const sendNotification = vi.fn();
    const notifier = createNativeNotifier(bridge({ sendNotification }));
    expect(await notifier.send("Session 1 · Project", "The agent finished its turn.")).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Session 1 · Project",
      body: "The agent finished its turn.",
    });
  });

  it("does not deliver when the OS refused, and says so", async () => {
    const sendNotification = vi.fn();
    const notifier = createNativeNotifier(
      bridge({ webviewPermission: () => "denied", sendNotification }),
    );
    expect(await notifier.send("t", "b")).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

const now = Date.parse("2026-09-01T01:00:00.000Z");

function notice(
  sessionId: string,
  kind: RuntimeAttentionNotice["event"]["kind"],
  secondsAgo = 5,
): RuntimeAttentionNotice {
  const event: RuntimeAttentionNotice["event"] =
    kind === "error"
      ? { kind, fault: null }
      : kind === "exited"
        ? { kind, exitCode: 1 }
        : { kind, lastTool: null };
  return {
    source: "local-pty",
    id: `runtime:${sessionId}:1:${kind}`,
    projectId: "project-1",
    sessionId,
    observedAt: new Date(now - secondsAgo * 1000).toISOString(),
    event,
  };
}

const allowAll = { enabled: () => true, focused: () => false };

describe("what gets handed to the OS", () => {
  it("fires fresh turn-complete and needs-input notices and remembers them", () => {
    const notices = [notice("s1", "turn-complete"), notice("s2", "needs-input")];
    const plan = planNativeNotifications(notices, { seen: new Set(), nowMs: now, ...allowAll });
    expect(plan.fire.map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
    expect(plan.seen.size).toBe(2);

    const again = planNativeNotifications(notices, { seen: plan.seen, nowMs: now, ...allowAll });
    expect(again.fire).toEqual([]);
  });

  it("leaves PTY errors and exits to the in-app inbox", () => {
    const plan = planNativeNotifications([notice("s1", "error"), notice("s2", "exited")], {
      seen: new Set(),
      nowMs: now,
      ...allowAll,
    });
    expect(plan.fire).toEqual([]);
    expect(plan.seen.size).toBe(0);
  });

  it("stays silent for the pane the person is already looking at — and does not fire later", () => {
    const notices = [notice("s1", "turn-complete")];
    const focused = planNativeNotifications(notices, {
      seen: new Set(),
      nowMs: now,
      enabled: () => true,
      focused: (entry) => entry.sessionId === "s1",
    });
    expect(focused.fire).toEqual([]);
    expect(focused.seen.size).toBe(1);

    const unfocused = planNativeNotifications(notices, {
      seen: focused.seen,
      nowMs: now,
      ...allowAll,
    });
    expect(unfocused.fire).toEqual([]);
  });

  it("respects the notifications toggle per notice", () => {
    const plan = planNativeNotifications(
      [notice("s1", "turn-complete"), notice("s2", "turn-complete")],
      {
        seen: new Set(),
        nowMs: now,
        enabled: (entry) => entry.sessionId === "s2",
        focused: () => false,
      },
    );
    expect(plan.fire.map((entry) => entry.sessionId)).toEqual(["s2"]);
  });

  it("does not announce history: a notice already old when first seen is skipped", () => {
    const plan = planNativeNotifications([notice("s1", "turn-complete", 3600)], {
      seen: new Set(),
      nowMs: now,
      ...allowAll,
    });
    expect(plan.fire).toEqual([]);
    expect(plan.seen.size).toBe(1);
  });

  it("forgets keys whose notice is gone, so the next turn of the same session fires again", () => {
    const first = notice("s1", "turn-complete");
    const plan = planNativeNotifications([first], { seen: new Set(), nowMs: now, ...allowAll });
    const cleared = planNativeNotifications([], { seen: plan.seen, nowMs: now, ...allowAll });
    expect(cleared.seen.size).toBe(0);

    const next = { ...first, observedAt: new Date(now).toISOString() };
    const replay = planNativeNotifications([next], { seen: cleared.seen, nowMs: now, ...allowAll });
    expect(replay.fire).toEqual([next]);
  });
});
