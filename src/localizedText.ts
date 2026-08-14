export type LocalizedText =
  | string
  | { kind: "page-title"; index: number }
  | { kind: "session-title"; index: number }
  | {
      kind:
        | "default-profile"
        | "session-created"
        | "session-restored"
        | "ready-intro"
        | "ready-outcome"
        | "ready-next"
        | "restored-intro"
        | "restored-outcome"
        | "restored-next";
    };

type GeneratedMessageKey =
  | "pages.defaultTitle"
  | "session.defaultTitle"
  | "session.defaultProfile"
  | "session.createdNow"
  | "session.restored"
  | "session.readyIntro"
  | "session.readyOutcome"
  | "session.readyNext"
  | "session.restoredIntro"
  | "session.restoredOutcome"
  | "session.restoredNext";

type TranslateGeneratedCopy = (
  key: GeneratedMessageKey,
  values?: Record<string, string | number>,
) => string;

const STATIC_MESSAGE_KEYS = {
  "default-profile": "session.defaultProfile",
  "session-created": "session.createdNow",
  "session-restored": "session.restored",
  "ready-intro": "session.readyIntro",
  "ready-outcome": "session.readyOutcome",
  "ready-next": "session.readyNext",
  "restored-intro": "session.restoredIntro",
  "restored-outcome": "session.restoredOutcome",
  "restored-next": "session.restoredNext",
} as const satisfies Record<
  Exclude<LocalizedText, string | { kind: "page-title" | "session-title"; index: number }>["kind"],
  GeneratedMessageKey
>;

export function resolveLocalizedText(value: LocalizedText, t: TranslateGeneratedCopy): string {
  if (typeof value === "string") return value;
  if (value.kind === "page-title") return t("pages.defaultTitle", { index: value.index });
  if (value.kind === "session-title") return t("session.defaultTitle", { index: value.index });
  return t(STATIC_MESSAGE_KEYS[value.kind]);
}

export function readLocalizedText(value: unknown): LocalizedText | null {
  if (typeof value === "string") return value;
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "page-title" || value.kind === "session-title") {
    return Number.isInteger(value.index) && Number(value.index) > 0 && Number(value.index) <= 10_000
      ? { kind: value.kind, index: Number(value.index) }
      : null;
  }
  return Object.prototype.hasOwnProperty.call(STATIC_MESSAGE_KEYS, value.kind)
    ? { kind: value.kind as keyof typeof STATIC_MESSAGE_KEYS }
    : null;
}

export function readSessionTitle(
  value: unknown,
): string | { kind: "session-title"; index: number } | null {
  const parsed = readLocalizedText(value);
  return typeof parsed === "string" || parsed?.kind === "session-title" ? parsed : null;
}

export function readPageTitle(
  value: unknown,
): string | { kind: "page-title"; index: number } | null {
  const parsed = readLocalizedText(value);
  return typeof parsed === "string" || parsed?.kind === "page-title" ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
