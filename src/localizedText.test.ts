import { describe, expect, it } from "vitest";
import { formatLocalizedText } from "./i18n";
import {
  readLocalizedText,
  readPageTitle,
  readSessionTitle,
  resolveLocalizedText,
} from "./localizedText";

const messages = {
  "pages.defaultTitle": "Page {index}",
  "session.defaultTitle": "Session {index}",
  "session.defaultProfile": "Default terminal",
  "session.createdNow": "Created now",
  "session.restored": "Restored",
  "session.readyIntro": "Ready",
  "session.readyOutcome": "Start",
  "session.readyNext": "Continue",
  "session.restoredIntro": "Stored",
  "session.restoredOutcome": "Restored workspace",
  "session.restoredNext": "Restart",
} as const;

const t = (key: keyof typeof messages, values?: Record<string, string | number>) => {
  let message: string = messages[key];
  for (const [name, value] of Object.entries(values ?? {})) {
    message = message.replace(`{${name}}`, String(value));
  }
  return message;
};

describe("localized generated copy", () => {
  it("resolves semantic copy at render time and preserves literal user text", () => {
    expect(resolveLocalizedText({ kind: "page-title", index: 3 }, t)).toBe("Page 3");
    expect(resolveLocalizedText({ kind: "ready-next" }, t)).toBe("Continue");
    expect(resolveLocalizedText("사용자 제목", t)).toBe("사용자 제목");
  });

  it("switches generated copy between Korean and English without changing literals", () => {
    const page = { kind: "page-title" as const, index: 3 };
    expect(formatLocalizedText("ko", page)).toBe("페이지 3");
    expect(formatLocalizedText("en", page)).toBe("Page 3");
    expect(formatLocalizedText("ko", "API review")).toBe("API review");
    expect(formatLocalizedText("en", "API review")).toBe("API review");
  });

  it("accepts bounded semantic copy and rejects malformed persisted values", () => {
    expect(readLocalizedText({ kind: "session-title", index: 2 })).toEqual({
      kind: "session-title",
      index: 2,
    });
    expect(readLocalizedText({ kind: "session-title", index: 0 })).toBeNull();
    expect(readLocalizedText({ kind: "unknown" })).toBeNull();
    expect(readLocalizedText({ kind: "toString" })).toBeNull();
    expect(readLocalizedText({ kind: "__proto__" })).toBeNull();
  });

  it("accepts only the semantic kind allowed by each persisted title field", () => {
    expect(readSessionTitle({ kind: "session-title", index: 2 })).toEqual({
      kind: "session-title",
      index: 2,
    });
    expect(readSessionTitle({ kind: "page-title", index: 2 })).toBeNull();
    expect(readSessionTitle({ kind: "ready-next" })).toBeNull();
    expect(readPageTitle({ kind: "page-title", index: 3 })).toEqual({
      kind: "page-title",
      index: 3,
    });
    expect(readPageTitle({ kind: "session-title", index: 3 })).toBeNull();
    expect(readPageTitle("Custom page")).toBe("Custom page");
  });
});
