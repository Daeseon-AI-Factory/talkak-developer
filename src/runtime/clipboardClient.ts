import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The OS clipboard, through the native command boundary.
 *
 * `navigator.clipboard` is the browser-preview path only. In the desktop WebView it refuses in
 * ordinary situations — the document must be focused and the origin trusted — and a refusal
 * arrives as a rejected promise, so a copy that silently never happened looked identical to one
 * that worked. The native path has no permission surface.
 */
export interface ClipboardClient {
  writeText: (text: string) => Promise<void>;
  readText: () => Promise<string>;
  /** A path to the clipboard image written to disk, or null when there is no image. */
  readImagePath: () => Promise<string | null>;
}

export function createClipboardClient(
  invokeCommand: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
): ClipboardClient {
  return {
    writeText: (text) => invokeCommand<void>("clipboard_write_text", { text }),
    readText: () => invokeCommand<string>("clipboard_read_text"),
    readImagePath: () => invokeCommand<string | null>("clipboard_read_image_path"),
  };
}

/** Browser-preview counterpart: the web API is all there is outside the desktop app. */
export function createBrowserClipboardClient(): ClipboardClient {
  return {
    writeText: (text) => navigator.clipboard.writeText(text),
    readText: () => navigator.clipboard.readText(),
    // The browser preview has no filesystem to write an image to.
    readImagePath: async () => null,
  };
}

export const clipboardClient: ClipboardClient = isTauri()
  ? createClipboardClient(invoke)
  : createBrowserClipboardClient();
