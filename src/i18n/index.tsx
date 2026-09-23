import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import type { SessionState, TerminalRuntimePhase } from "../domain";
import { type LocalizedText, resolveLocalizedText } from "../localizedText";
import { exitWasInterrupted } from "../runtime/exitStatus";
import { type MessageKey, en, ko } from "./strings";

export type Locale = "ko" | "en";

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  text: (value: LocalizedText) => string;
  statusLabel: (state: SessionState) => string;
  runtimePhaseLabel: (phase: TerminalRuntimePhase, exitCode?: number | null) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function translate(
  locale: Locale,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const dictionary = locale === "ko" ? ko : en;
  let message: string = dictionary[key];
  for (const [name, replacement] of Object.entries(values ?? {})) {
    message = message.split(`{${name}}`).join(String(replacement));
  }
  return message;
}

export function formatLocalizedText(locale: Locale, value: LocalizedText): string {
  return resolveLocalizedText(value, (key, values) => translate(locale, key, values));
}

function readInitialLocale(): Locale {
  try {
    return localStorage.getItem("talkak.locale") === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(readInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("talkak.locale", locale);
    } catch {
      // The language switch still works when storage is unavailable.
    }
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    const t: I18nValue["t"] = (key, values) => translate(locale, key, values);
    const statusKeys: Record<SessionState, MessageKey> = {
      working: "status.working",
      "needs-input": "status.needsInput",
      ready: "status.ready",
      idle: "status.idle",
    };
    return {
      locale,
      setLocale,
      toggleLocale: () => setLocale((current) => (current === "ko" ? "en" : "ko")),
      t,
      text: (text) => formatLocalizedText(locale, text),
      statusLabel: (state) => t(statusKeys[state]),
      runtimePhaseLabel: (phase, exitCode) => {
        if (phase === "starting") return t("terminal.starting");
        if (phase === "running") return t("terminal.running");
        if (phase === "stopping") return t("terminal.stopping");
        if (phase === "exited") {
          if (exitWasInterrupted(exitCode)) return t("terminal.interrupted");
          return exitCode === null || exitCode === undefined
            ? t("terminal.exited")
            : t("terminal.exitedCode", { code: exitCode });
        }
        if (phase === "error") return t("terminal.runtimeError");
        if (phase === "unavailable") return t("terminal.ptyDisconnected");
        return t("terminal.readyToStart");
      },
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
