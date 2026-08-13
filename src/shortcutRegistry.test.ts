import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  commandForShortcut,
  matchesShortcut,
  shortcutChord,
  shortcutDisplay,
} from "./shortcutRegistry";

const event = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("shortcut registry", () => {
  it("renders platform-specific labels", () => {
    expect(shortcutDisplay("macos", "splitRight")).toBe("⌘D");
    expect(shortcutDisplay("macos", "splitDown")).toBe("⌘⇧D");
    expect(shortcutDisplay("macos", "terminalLog")).toBe("⌘L");
    expect(shortcutDisplay("windows", "splitRight")).toBe("Ctrl+Shift+D");
    expect(shortcutDisplay("windows", "splitDown")).toBe("Ctrl+Shift+S");
    expect(shortcutDisplay("windows", "terminalLog")).toBe("Ctrl+Shift+L");
  });

  it("does not consume plain Windows terminal control chords", () => {
    for (const code of ["KeyC", "KeyD", "KeyK", "KeyL", "KeyR", "KeyU", "KeyW"]) {
      expect(commandForShortcut(event({ code, ctrlKey: true }), "windows", true)).toBeNull();
    }
  });

  it("matches exact modifiers and respects workspace scope", () => {
    const chord = shortcutChord("windows", "newPage");
    expect(matchesShortcut(event({ code: "KeyN", ctrlKey: true, shiftKey: true }), chord)).toBe(
      true,
    );
    expect(
      commandForShortcut(event({ code: "KeyN", ctrlKey: true, shiftKey: true }), "windows", false),
    ).toBeNull();
  });

  it("has no duplicate chord within a platform and scope", () => {
    for (const platform of ["macos", "windows"] as const) {
      const seen = new Set<string>();
      for (const definition of SHORTCUTS) {
        const chord = shortcutChord(platform, definition.id);
        const key = [chord.code, chord.meta, chord.ctrl, chord.alt, chord.shift].join(":");
        expect(seen.has(key), `${platform} duplicate ${definition.id}`).toBe(false);
        seen.add(key);
      }
    }
  });
});
