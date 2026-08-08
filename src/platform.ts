export type DesktopPlatform = "macos" | "windows" | "other";

export function platformFromUserAgent(userAgent: string): DesktopPlatform {
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "macos";
  return "other";
}

export function shortcutLabel(platform: DesktopPlatform, key: string): string {
  const modifier = platform === "macos" ? "⌘" : "Ctrl";
  return `${modifier} ${key.toLocaleUpperCase()}`;
}
