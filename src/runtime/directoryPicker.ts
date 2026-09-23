import { isTauri } from "@tauri-apps/api/core";

interface OpenDirectoryOptions {
  directory: true;
  multiple: false;
  defaultPath?: string;
  title?: string;
}

type OpenDirectoryDialog = (options: OpenDirectoryOptions) => Promise<string | string[] | null>;

export interface DirectoryPicker {
  available: () => boolean;
  pick: (defaultPath: string, title: string) => Promise<string | null>;
}

export function createDirectoryPicker(
  available: () => boolean,
  openDialog: OpenDirectoryDialog,
): DirectoryPicker {
  return {
    available,
    async pick(defaultPath, title) {
      if (!available()) return null;
      const selected = await openDialog({
        directory: true,
        multiple: false,
        ...(defaultPath.trim() ? { defaultPath: defaultPath.trim() } : {}),
        title,
      });
      return typeof selected === "string" ? selected : null;
    },
  };
}

export const directoryPicker = createDirectoryPicker(isTauri, async (options) => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open(options);
});
