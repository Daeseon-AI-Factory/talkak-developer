import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  commandForShortcut,
  matchesShortcut,
  shortcutChord,
  shortcutDisplay,
  shortcutPairDisplay,
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
    expect(shortcutDisplay("windows", "splitDown")).toBe("Ctrl+Alt+D");
    expect(shortcutDisplay("windows", "terminalLog")).toBe("Ctrl+Shift+L");
  });

  it("uses the same split key on both platforms without colliding on Windows", () => {
    expect(
      commandForShortcut(event({ code: "KeyD", ctrlKey: true, altKey: true }), "windows", true)?.id,
    ).toBe("splitDown");
    expect(
      commandForShortcut(event({ code: "KeyS", ctrlKey: true, shiftKey: true }), "windows", true),
    ).toBeNull();
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

  it("jumps to a project by number from any screen without taking the pane digits", () => {
    expect(shortcutDisplay("macos", "focusProject4")).toBe("⌘⌥4");
    expect(shortcutDisplay("windows", "focusProject4")).toBe("Ctrl+Alt+4");
    // Global: a project switch is how you leave any screen, so it works with the workspace off.
    expect(
      commandForShortcut(event({ code: "Digit4", metaKey: true, altKey: true }), "macos", false)
        ?.id,
    ).toBe("focusProject4");
    expect(
      commandForShortcut(event({ code: "Digit9", ctrlKey: true, altKey: true }), "windows", false)
        ?.id,
    ).toBe("focusProject9");
    // The pane jump keeps its chord; plain Ctrl+digit still reaches the Windows terminal.
    expect(commandForShortcut(event({ code: "Digit4", metaKey: true }), "macos", true)?.id).toBe(
      "focusPane4",
    );
    expect(
      commandForShortcut(event({ code: "Digit4", ctrlKey: true }), "windows", true),
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

describe("paired shortcut display", () => {
  it("says a shared Windows modifier once instead of twice", () => {
    // A spelled-out pair ("Ctrl+Shift+← · Ctrl+Shift+→") overflowed the page hint and was cut
    // mid-word; a shared prefix is said once.
    expect(shortcutPairDisplay("windows", "previousPage", "nextPage")).toBe("Ctrl+Shift+←/→");
    expect(shortcutPairDisplay("windows", "previousPane", "nextPane")).toBe("Ctrl+Shift+[/]");
  });

  it("leaves the macOS symbols alone, having no modifier text to share", () => {
    expect(shortcutPairDisplay("macos", "previousPage", "nextPage")).toBe("⌘⌥← · ⌘⌥→");
    expect(shortcutPairDisplay("macos", "previousPane", "nextPane")).toBe("⌘[ · ⌘]");
  });

  it("never renders wider than spelling both chords out", () => {
    for (const platform of ["macos", "windows"] as const) {
      const paired = shortcutPairDisplay(platform, "previousPage", "nextPage");
      const spelled = `${shortcutDisplay(platform, "previousPage")} · ${shortcutDisplay(
        platform,
        "nextPage",
      )}`;
      expect(paired.length).toBeLessThanOrEqual(spelled.length);
    }
  });
});
