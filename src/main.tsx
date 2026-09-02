import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { I18nProvider } from "./i18n";
// Ahead of every other sheet so the bundled faces are declared before anything asks for them.
import "./styles/fonts.css";
import "./styles/foundation.css";
import "./styles/workspace.css";
import "./styles/terminal-runtime.css";
import "./styles/inspector.css";
import "./styles/collections.css";
import "./styles/responsive.css";
import "./styles/shell-layout.css";
import "./styles/attention-settings.css";
import "./styles/adaptive.css";
import "./styles/project-dialog.css";
import "./styles/confirm.css";
import "./styles/shortcut-guide.css";

declare const __TALKAK_WEBDRIVER_CI__: boolean;

async function renderApplication() {
  if (__TALKAK_WEBDRIVER_CI__) {
    await import("@wdio/tauri-plugin");
    const { installWebdriverTestHooks } = await import("./webdriverTestHooks");
    installWebdriverTestHooks();
  }

  const root = document.getElementById("root");

  if (!root) {
    throw new Error("Missing #root element");
  }

  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
}

void renderApplication();
