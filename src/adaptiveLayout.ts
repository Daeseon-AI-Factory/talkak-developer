export type PresentationMode = "phone" | "tablet" | "desktop";

export const PHONE_MAX_WIDTH = 720;
export const TABLET_MAX_WIDTH = 1100;

export function presentationModeForWidth(width: number): PresentationMode {
  if (width <= PHONE_MAX_WIDTH) return "phone";
  if (width <= TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}
