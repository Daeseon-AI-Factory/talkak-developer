import { useState } from "react";
import { useI18n } from "../i18n";
import {
  type NativePermissionView,
  useNativeNotificationPermission,
} from "../runtime/nativeNotifications";
import {
  type FeatureSettingId,
  type SettingScope,
  type SettingsState,
  effectiveSetting,
  featureSettingIds,
} from "../settingsModel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { TerminalSettingsSection } from "./TerminalSettingsSection";

interface SettingsPanelProps {
  state: SettingsState;
  projectId: string;
  sessionId: string | null;
  onSetOverride: (
    scope: SettingScope,
    targetId: string | null,
    id: FeatureSettingId,
    value: boolean | null,
  ) => void;
}

const settingKeys = {
  sessionSummaries: ["settings.sessionSummaries", "settings.sessionSummariesHint"],
  conversationIndexing: ["settings.conversationIndexing", "settings.conversationIndexingHint"],
  attentionDetection: ["settings.attentionDetection", "settings.attentionDetectionHint"],
  notifications: ["settings.notifications", "settings.notificationsHint"],
  riskConfirmations: ["settings.riskConfirmations", "settings.riskConfirmationsHint"],
  remoteAccess: ["settings.remoteAccess", "settings.remoteAccessHint"],
  voiceInput: ["settings.voiceInput", "settings.voiceInputHint"],
} as const;

export function SettingsPanel({ state, projectId, sessionId, onSetOverride }: SettingsPanelProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<SettingScope>("app");
  const nativePermission = useNativeNotificationPermission();
  const context =
    scope === "app"
      ? {}
      : scope === "project"
        ? { projectId }
        : { projectId, sessionId: sessionId ?? undefined };
  const targetId = scope === "app" ? null : scope === "project" ? projectId : sessionId;

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <header className="settings-panel__header">
        <span>{t("settings.eyebrow")}</span>
        <h1 id="settings-title">{t("settings.title")}</h1>
        <p>{t("settings.description")}</p>
        <strong>{t("settings.preview")}</strong>
      </header>

      <div className="settings-scope">
        <span>{t("settings.scope")}</span>
        <fieldset aria-label={t("settings.scope")}>
          {(["app", "project", "session"] as const).map((candidate) => (
            <button
              type="button"
              key={candidate}
              aria-pressed={scope === candidate}
              data-active={scope === candidate}
              disabled={candidate === "session" && !sessionId}
              onClick={() => setScope(candidate)}
            >
              {t(`settings.scope.${candidate}`)}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="settings-list">
        {featureSettingIds.map((id) => {
          const [labelKey, hintKey] = settingKeys[id];
          const override = readOverride(state, scope, targetId, id);
          const effective = effectiveSetting(state, id, context);
          return (
            <article className="setting-card" key={id}>
              <div>
                <strong>{t(labelKey)}</strong>
                <p>{t(hintKey)}</p>
                {id === "notifications" ? (
                  <NativeNotificationStatus
                    permission={nativePermission.permission}
                    effective={effective}
                    onRequest={nativePermission.request}
                  />
                ) : null}
              </div>
              <fieldset
                className="setting-control"
                aria-label={`${t(labelKey)} · ${effective ? t("settings.on") : t("settings.off")}`}
              >
                {scope !== "app" ? (
                  <button
                    type="button"
                    data-active={override === undefined}
                    onClick={() => onSetOverride(scope, targetId, id, null)}
                  >
                    {t("settings.inherited")}
                  </button>
                ) : null}
                <button
                  type="button"
                  data-active={override === false || (scope === "app" && override === undefined)}
                  onClick={() => onSetOverride(scope, targetId, id, false)}
                >
                  {t("settings.off")}
                </button>
                <button
                  type="button"
                  data-active={override === true}
                  onClick={() => onSetOverride(scope, targetId, id, true)}
                >
                  {t("settings.on")}
                </button>
              </fieldset>
            </article>
          );
        })}
      </div>

      <TerminalSettingsSection />
      <DiagnosticsPanel />
    </section>
  );
}

const permissionKeys: Record<
  NativePermissionView,
  | "settings.nativePermission.checking"
  | "settings.nativePermission.granted"
  | "settings.nativePermission.denied"
  | "settings.nativePermission.prompt"
  | "settings.nativePermission.unavailable"
> = {
  checking: "settings.nativePermission.checking",
  granted: "settings.nativePermission.granted",
  denied: "settings.nativePermission.denied",
  prompt: "settings.nativePermission.prompt",
  unavailable: "settings.nativePermission.unavailable",
};

/**
 * What the OS side will actually do, next to the toggle that asks for it. The toggle is a wish;
 * this is the fact — and when the two disagree, the panel says so rather than showing "On".
 */
function NativeNotificationStatus({
  permission,
  effective,
  onRequest,
}: {
  permission: NativePermissionView;
  effective: boolean;
  onRequest: () => void;
}) {
  const { t } = useI18n();
  return (
    <p
      className="setting-card__native"
      data-testid="native-notification-status"
      data-permission={permission}
    >
      <span>{t("settings.nativePermission")}</span> <span>{t(permissionKeys[permission])}</span>
      {permission === "prompt" ? (
        <button type="button" onClick={onRequest}>
          {t("settings.nativePermission.request")}
        </button>
      ) : null}
      {effective && permission !== "granted" && permission !== "checking" ? (
        <strong>{t("settings.notificationsBlocked")}</strong>
      ) : null}
    </p>
  );
}

function readOverride(
  state: SettingsState,
  scope: SettingScope,
  targetId: string | null,
  id: FeatureSettingId,
): boolean | undefined {
  if (scope === "app") return state.app[id];
  if (!targetId) return undefined;
  return scope === "project" ? state.projects[targetId]?.[id] : state.sessions[targetId]?.[id];
}
