export type DesktopPlatform = "macos" | "windows" | "other";

export function platformFromUserAgent(userAgent: string): DesktopPlatform {
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "macos";
  return "other";
}
