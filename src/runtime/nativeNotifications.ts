import { isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useState } from "react";
import {
  type RuntimeAttentionNotice,
  isAgentRecordNotice,
  runtimeAttentionNoticeKey,
} from "./runtimeAttentionModel";

/**
 * Native OS notifications for agent turn-complete and needs-input notices.
 *
 * The in-app inbox already carries every notice; this is the part that reaches someone who is in
 * another window. Windows and macOS both go through the same Tauri plugin — there is no per-OS
 * settings deep link, because there is no Windows counterpart for one.
 *
 * Honesty caveat: on desktop the plugin reports permission as granted without asking the OS, and
 * it cannot see whether the system later hid the notification (Focus modes, per-app settings). So
 * "granted" here means "the app is allowed to try", and the settings copy says exactly that.
 */
export type NativeNotificationPermission = "granted" | "denied" | "prompt" | "unavailable";

export interface NativeNotifier {
  available: () => boolean;
  permission: () => Promise<NativeNotificationPermission>;
  request: () => Promise<NativeNotificationPermission>;
  /** True when the notification was handed to the OS; false when refused or unavailable. */
  send: (title: string, body: string) => Promise<boolean>;
}

export interface NativeNotifierBridge {
  available: () => boolean;
  /** The webview's own three-state answer, when it has one; null where `Notification` is absent. */
  webviewPermission: () => "granted" | "denied" | "default" | null;
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<string>;
  sendNotification: (options: { title: string; body: string }) => void;
}

export function createNativeNotifier(bridge: NativeNotifierBridge): NativeNotifier {
  let requested = false;

  async function permission(): Promise<NativeNotificationPermission> {
    if (!bridge.available()) return "unavailable";
    try {
      const webview = bridge.webviewPermission();
      if (webview === "granted" || webview === "denied") return webview;
      if (await bridge.isPermissionGranted()) return "granted";
      return requested ? "denied" : "prompt";
    } catch {
      return "unavailable";
    }
  }

  async function request(): Promise<NativeNotificationPermission> {
    if (!bridge.available()) return "unavailable";
    try {
      requested = true;
      const answer = await bridge.requestPermission();
      return answer === "granted" ? "granted" : "denied";
    } catch {
      return "unavailable";
    }
  }

  return {
    available: bridge.available,
    permission,
    request,
    send: async (title, body) => {
      let state = await permission();
      if (state === "prompt") state = await request();
      if (state !== "granted") return false;
      try {
        bridge.sendNotification({ title, body });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const nativeNotifier = createNativeNotifier({
  available: isTauri,
  webviewPermission: () => {
    if (typeof Notification === "undefined") return null;
    const state = Notification.permission;
    return state === "granted" || state === "denied" || state === "default" ? state : null;
  },
  isPermissionGranted,
  requestPermission,
  sendNotification,
});

/** A notice older than this when first seen is history, not news — typical of an app restart. */
export const NATIVE_NOTICE_FRESHNESS_MS = 60_000;

export interface NativeNotificationPlanInput {
  /** Notice keys already fired or deliberately skipped. */
  seen: ReadonlySet<string>;
  nowMs: number;
  freshnessMs?: number;
  /** The notifications feature toggle, resolved for this notice's project and session. */
  enabled: (notice: RuntimeAttentionNotice) => boolean;
  /** The notice's pane is focused inside a focused window: the person is already looking at it. */
  focused: (notice: RuntimeAttentionNotice) => boolean;
}

export interface NativeNotificationPlan {
  fire: RuntimeAttentionNotice[];
  seen: Set<string>;
}

/**
 * Decide which notices to hand to the OS. Every new agent-record notice is marked seen on first
 * sight, fired or not: a reply that arrived while the pane was focused must not pop up later just
 * because the person then switched away. The seen set is pruned to the notices still present, so
 * the next turn of the same session — a new key — fires again.
 */
export function planNativeNotifications(
  notices: readonly RuntimeAttentionNotice[],
  input: NativeNotificationPlanInput,
): NativeNotificationPlan {
  const freshnessMs = input.freshnessMs ?? NATIVE_NOTICE_FRESHNESS_MS;
  const fire: RuntimeAttentionNotice[] = [];
  const seen = new Set<string>();
  for (const notice of notices) {
    if (!isAgentRecordNotice(notice)) continue;
    const key = runtimeAttentionNoticeKey(notice);
    seen.add(key);
    if (input.seen.has(key)) continue;
    if (!isFresh(notice.observedAt, input.nowMs, freshnessMs)) continue;
    if (!input.enabled(notice)) continue;
    if (input.focused(notice)) continue;
    fire.push(notice);
  }
  return { fire, seen };
}

function isFresh(observedAt: string, nowMs: number, freshnessMs: number): boolean {
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at <= freshnessMs;
}

export type NativePermissionView = NativeNotificationPermission | "checking";

/** The plugin's answer for the settings screen, re-asked whenever the screen mounts. */
export function useNativeNotificationPermission(notifier: NativeNotifier = nativeNotifier): {
  permission: NativePermissionView;
  request: () => void;
} {
  const [permission, setPermission] = useState<NativePermissionView>("checking");

  useEffect(() => {
    let cancelled = false;
    void notifier.permission().then((state) => {
      if (!cancelled) setPermission(state);
    });
    return () => {
      cancelled = true;
    };
  }, [notifier]);

  const request = useCallback(() => {
    void notifier.request().then(setPermission);
  }, [notifier]);

  return { permission, request };
}
