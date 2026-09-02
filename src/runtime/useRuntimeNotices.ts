import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../domain";
import { useI18n } from "../i18n";
import { type SettingsState, effectiveSetting } from "../settingsModel";
import {
  type NativeNotifier,
  nativeNotifier,
  planNativeNotifications,
} from "./nativeNotifications";
import {
  type RuntimeAttentionNotice,
  runtimeAttentionNoticeKey,
  runtimeAttentionNotices,
} from "./runtimeAttentionModel";

interface RuntimeNoticesInput {
  projects: readonly Project[];
  settings: SettingsState;
  /** The session whose pane has focus while the workspace is on screen; null elsewhere. */
  focusedSessionId: string | null;
  notifier?: NativeNotifier;
  windowFocused?: () => boolean;
}

/**
 * The runtime notices the inbox shows — everything observed minus what the person acknowledged —
 * plus the native echo of the agent-record ones.
 *
 * Acknowledgement is per notice key, and keys carry the observation time, so acknowledging one
 * finished turn does not silence the next. Keys whose notice disappeared are dropped so the set
 * cannot grow for the life of the app.
 */
export function useRuntimeNotices({
  projects,
  settings,
  focusedSessionId,
  notifier = nativeNotifier,
  windowFocused = () => document.hasFocus(),
}: RuntimeNoticesInput): {
  runtimeNotices: RuntimeAttentionNotice[];
  acknowledgeRuntimeNotice: (notice: RuntimeAttentionNotice) => void;
} {
  const { t, text } = useI18n();
  const observed = useMemo(() => runtimeAttentionNotices(projects), [projects]);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const runtimeNotices = useMemo(
    () => observed.filter((notice) => !acknowledged.has(runtimeAttentionNoticeKey(notice))),
    [acknowledged, observed],
  );

  useEffect(() => {
    const activeKeys = new Set(observed.map(runtimeAttentionNoticeKey));
    setAcknowledged((current) => {
      const retained = new Set([...current].filter((key) => activeKeys.has(key)));
      return retained.size === current.size ? current : retained;
    });
  }, [observed]);

  // Refs, not deps: a settings or focus change must not replay notices already decided on.
  const seenRef = useRef<ReadonlySet<string>>(new Set());
  const contextRef = useRef({ settings, focusedSessionId, windowFocused, t, text, projects });
  contextRef.current = { settings, focusedSessionId, windowFocused, t, text, projects };

  useEffect(() => {
    const context = contextRef.current;
    const plan = planNativeNotifications(observed, {
      seen: seenRef.current,
      nowMs: Date.now(),
      enabled: (notice) =>
        effectiveSetting(context.settings, "notifications", {
          projectId: notice.projectId,
          sessionId: notice.sessionId,
        }),
      focused: (notice) => notice.sessionId === context.focusedSessionId && context.windowFocused(),
    });
    seenRef.current = plan.seen;
    for (const notice of plan.fire) {
      const project = context.projects.find((candidate) => candidate.id === notice.projectId);
      const session = project?.sessions.find((candidate) => candidate.id === notice.sessionId);
      const sessionTitle = session ? context.text(session.title) : notice.sessionId;
      const title = project ? `${sessionTitle} · ${project.name}` : sessionTitle;
      const body =
        notice.event.kind === "needs-input"
          ? context.t("attention.nativeNeedsInputBody")
          : context.t("attention.nativeTurnCompleteBody");
      void notifier.send(title, body);
    }
  }, [notifier, observed]);

  function acknowledgeRuntimeNotice(notice: RuntimeAttentionNotice) {
    const key = runtimeAttentionNoticeKey(notice);
    setAcknowledged((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  return { runtimeNotices, acknowledgeRuntimeNotice };
}
