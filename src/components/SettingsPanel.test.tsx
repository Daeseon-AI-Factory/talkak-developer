import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { createDefaultSettingsState, setSettingOverride } from "../settingsModel";
import { SettingsPanel } from "./SettingsPanel";

const permission = vi.hoisted(() => ({ current: "checking" as string }));

vi.mock("../runtime/nativeNotifications", () => ({
  useNativeNotificationPermission: () => ({ permission: permission.current, request: () => {} }),
}));

function render(notificationsOn: boolean): string {
  let state = createDefaultSettingsState();
  if (notificationsOn) state = setSettingOverride(state, "app", null, "notifications", true);
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsPanel
        state={state}
        projectId="project-1"
        projectPath={null}
        projectName="Preview"
        sessionId={null}
        onSetOverride={() => {}}
      />
    </I18nProvider>,
  );
}

function nativeBlock(markup: string): string {
  const start = markup.indexOf('data-testid="native-notification-status"');
  return markup.slice(start, markup.indexOf("</p>", start));
}

describe("SettingsPanel native notification status", () => {
  it("shows the system permission next to the toggle, and only there", () => {
    permission.current = "granted";
    const markup = render(false);
    expect(markup.split('data-testid="native-notification-status"').length).toBe(2);
    expect(nativeBlock(markup)).toContain('data-permission="granted"');
    expect(nativeBlock(markup)).toContain("OS 알림 설정을 따릅니다");
    expect(nativeBlock(markup)).not.toContain("<button");
  });

  it("offers to ask when nothing has been asked yet", () => {
    permission.current = "prompt";
    expect(nativeBlock(render(false))).toContain("권한 요청");
  });

  it("never lets the toggle read as delivering when the OS refused", () => {
    permission.current = "denied";
    const on = nativeBlock(render(true));
    expect(on).toContain('data-permission="denied"');
    expect(on).toContain("OS 알림은 전달되지 않습니다");

    const off = nativeBlock(render(false));
    expect(off).not.toContain("OS 알림은 전달되지 않습니다");
  });

  it("says plainly that the browser preview has no system notifications", () => {
    permission.current = "unavailable";
    expect(nativeBlock(render(true))).toContain("브라우저 미리보기에서는 사용할 수 없음");
  });
});
