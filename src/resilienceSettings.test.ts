import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECIPES,
  RESILIENCE_STORAGE_KEY,
  readResilienceSettings,
  recipePairs,
  writeResilienceSettings,
} from "./resilienceSettings";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("resilience settings", () => {
  it("defaults to login start and the known agents' resume recipes", () => {
    const settings = readResilienceSettings(null);
    expect(settings.brokerAutostart).toBe(true);
    expect(settings.recipes).toEqual(DEFAULT_RECIPES);
  });

  it("keeps a user's recipe, fills missing agents from the defaults, and survives bad JSON", () => {
    const storage = memoryStorage({
      [RESILIENCE_STORAGE_KEY]: JSON.stringify({
        brokerAutostart: false,
        recipes: { claude: "claude --resume {id}", extra: "tool {id}" },
      }),
    });
    const settings = readResilienceSettings(storage);
    expect(settings.brokerAutostart).toBe(false);
    expect(settings.recipes.claude).toBe("claude --resume {id}");
    expect(settings.recipes.codex).toBe(DEFAULT_RECIPES.codex);
    expect(settings.recipes.extra).toBe("tool {id}");
    expect(readResilienceSettings(memoryStorage({ [RESILIENCE_STORAGE_KEY]: "{oops" }))).toEqual(
      readResilienceSettings(null),
    );
  });

  it("round-trips and hands the native side every pair, empty ones included", () => {
    const storage = memoryStorage();
    const settings = readResilienceSettings(null);
    settings.recipes.antigravity = "";
    writeResilienceSettings(storage, settings);
    expect(readResilienceSettings(storage)).toEqual(settings);
    expect(recipePairs(settings)).toContainEqual(["antigravity", ""]);
  });
});
