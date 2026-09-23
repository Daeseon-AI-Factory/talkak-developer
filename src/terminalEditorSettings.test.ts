import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTerminalEditorSetting,
  resetTerminalEditorSettingCache,
  setTerminalEditorSetting,
  subscribeTerminalEditorSetting,
} from "./terminalEditorSettings";

// The suite runs in Node, which has no `localStorage` global; a minimal in-memory stand-in is
// enough to exercise the module's read/write/parse paths without adding a DOM test dependency.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  clear(): void {
    this.store.clear();
  }
}
globalThis.localStorage = new FakeLocalStorage() as unknown as Storage;

beforeEach(() => {
  localStorage.clear();
  resetTerminalEditorSettingCache();
});

describe("the editor a path:line link launches", () => {
  it("defaults to the OS default app with no template", () => {
    expect(activeTerminalEditorSetting()).toEqual({ command: null, argsTemplate: [] });
  });

  it("persists a custom command and reads it back on the next call", () => {
    setTerminalEditorSetting({ command: "code", argsTemplate: ["-g", "{file}:{line}"] });
    expect(activeTerminalEditorSetting()).toEqual({
      command: "code",
      argsTemplate: ["-g", "{file}:{line}"],
    });
    resetTerminalEditorSettingCache();
    expect(activeTerminalEditorSetting()).toEqual({
      command: "code",
      argsTemplate: ["-g", "{file}:{line}"],
    });
  });

  it("treats a blank command the same as none, so an empty field falls back honestly", () => {
    localStorage.setItem(
      "talkak.terminalEditor",
      JSON.stringify({ command: "   ", argsTemplate: [] }),
    );
    expect(activeTerminalEditorSetting().command).toBeNull();
  });

  it("ignores corrupted storage rather than throwing", () => {
    localStorage.setItem("talkak.terminalEditor", "{not json");
    expect(activeTerminalEditorSetting()).toEqual({ command: null, argsTemplate: [] });
  });

  it("notifies every subscriber when the choice changes", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeTerminalEditorSetting((setting) => seen.push(setting.command));
    setTerminalEditorSetting({ command: "cursor", argsTemplate: [] });
    unsubscribe();
    setTerminalEditorSetting({ command: "zed", argsTemplate: [] });
    expect(seen).toEqual(["cursor"]);
  });
});
