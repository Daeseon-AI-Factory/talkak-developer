import { useI18n } from "../i18n";
import {
  type TerminalEditorSetting,
  setTerminalEditorSetting,
  useTerminalEditorSetting,
} from "../terminalEditorSettings";
import {
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEME_PRESETS,
  setActiveTerminalThemeId,
  useTerminalTheme,
} from "../terminalTheme";

/**
 * Terminal-only settings: the palette every pane and the log share, and the editor a `path:line`
 * link launches. Both are per-device choices (this browser's storage only), so they live apart
 * from the project/session feature toggles above and apply the moment they change — no save
 * button, nothing to leave half-set.
 */
export function TerminalSettingsSection() {
  const { t } = useI18n();
  const theme = useTerminalTheme();
  const editor = useTerminalEditorSetting();
  const usesCustomEditor = editor.command !== null;

  function setEditor(next: TerminalEditorSetting) {
    setTerminalEditorSetting(next);
  }

  return (
    <section className="settings-list terminal-settings" aria-labelledby="terminal-settings-title">
      <header className="settings-panel__header">
        <span id="terminal-settings-title">{t("terminal.settings.eyebrow")}</span>
      </header>

      <article className="setting-card">
        <div>
          <strong>{t("terminal.settings.theme")}</strong>
          <p>{t("terminal.settings.themeHint")}</p>
        </div>
        <fieldset
          className="setting-control terminal-settings__themes"
          aria-label={t("terminal.settings.theme")}
        >
          {TERMINAL_THEME_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              data-active={theme.id === preset.id}
              className="terminal-settings__swatch"
              style={{ background: preset.theme.background, color: preset.theme.foreground }}
              onClick={() => setActiveTerminalThemeId(preset.id)}
            >
              {preset.id === DEFAULT_TERMINAL_THEME_ID
                ? t("terminal.settings.themeDefault", { name: preset.name })
                : preset.name}
            </button>
          ))}
        </fieldset>
      </article>

      <article className="setting-card">
        <div>
          <strong>{t("terminal.settings.editor")}</strong>
          <p>{t("terminal.settings.editorHint")}</p>
        </div>
        <div className="setting-control terminal-settings__editor">
          <fieldset aria-label={t("terminal.settings.editor")}>
            <button
              type="button"
              data-active={!usesCustomEditor}
              onClick={() => setEditor({ command: null, argsTemplate: editor.argsTemplate })}
            >
              {t("terminal.settings.editorOsDefault")}
            </button>
            <button
              type="button"
              data-active={usesCustomEditor}
              onClick={() =>
                setEditor({ command: editor.command ?? "", argsTemplate: editor.argsTemplate })
              }
            >
              {t("terminal.settings.editorCustom")}
            </button>
          </fieldset>
          {usesCustomEditor ? (
            <>
              <label className="terminal-settings__field">
                <span>{t("terminal.settings.editorCommand")}</span>
                <input
                  value={editor.command ?? ""}
                  placeholder={t("terminal.settings.editorCommandPlaceholder")}
                  onChange={(event) =>
                    setEditor({
                      command: event.currentTarget.value,
                      argsTemplate: editor.argsTemplate,
                    })
                  }
                />
              </label>
              <label className="terminal-settings__field">
                <span>{t("terminal.settings.editorArgs")}</span>
                <input
                  value={editor.argsTemplate.join(" ")}
                  placeholder={t("terminal.settings.editorArgsPlaceholder")}
                  onChange={(event) =>
                    setEditor({
                      command: editor.command,
                      argsTemplate: event.currentTarget.value.split(/\s+/).filter(Boolean),
                    })
                  }
                />
              </label>
            </>
          ) : null}
        </div>
      </article>
    </section>
  );
}
