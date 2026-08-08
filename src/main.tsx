import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./styles/foundation.css";
import "./styles/workspace.css";
import "./styles/terminal-runtime.css";
import "./styles/inspector.css";
import "./styles/collections.css";
import "./styles/responsive.css";
import "./styles/shell-layout.css";
import "./styles/attention-settings.css";
import "./styles/adaptive.css";

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
