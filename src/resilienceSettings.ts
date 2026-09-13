/**
 * How sessions come back: the agent resume recipe per agent name (`{id}` stands for the record
 * id the agent's CLI accepts), and whether the broker starts at login. Kept in browser storage
 * like the other settings; the native side receives the recipes with each resume and the login
 * preference at launch.
 */
export interface ResilienceSettings {
  brokerAutostart: boolean;
  recipes: Record<string, string>;
}

export const RESILIENCE_STORAGE_KEY = "talkak.resilience.v1";

/** Agent names the app recognises records for, in the order the settings show them. */
export const KNOWN_AGENTS: readonly string[] = ["claude", "codex", "antigravity"];

export const DEFAULT_RECIPES: Readonly<Record<string, string>> = {
  claude: "claude -r {id}",
  codex: "codex resume {id}",
  antigravity: "",
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaults(): ResilienceSettings {
  return { brokerAutostart: true, recipes: { ...DEFAULT_RECIPES } };
}

export function readResilienceSettings(storage: StorageLike | null): ResilienceSettings {
  const fallback = defaults();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(RESILIENCE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const record = parsed as Partial<ResilienceSettings>;
    const recipes = { ...DEFAULT_RECIPES };
    if (record.recipes && typeof record.recipes === "object") {
      for (const [name, recipe] of Object.entries(record.recipes)) {
        if (typeof recipe === "string") recipes[name] = recipe;
      }
    }
    return {
      brokerAutostart:
        typeof record.brokerAutostart === "boolean"
          ? record.brokerAutostart
          : fallback.brokerAutostart,
      recipes,
    };
  } catch {
    return fallback;
  }
}

export function writeResilienceSettings(
  storage: StorageLike | null,
  settings: ResilienceSettings,
): void {
  if (!storage) return;
  try {
    storage.setItem(RESILIENCE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Settings stay in effect for this run when storage is unavailable.
  }
}

/** The recipes as the native side takes them: name/recipe pairs, empty recipes included (= off). */
export function recipePairs(settings: ResilienceSettings): [string, string][] {
  return Object.entries(settings.recipes);
}

export function browserResilienceStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
