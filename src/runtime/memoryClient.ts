import { invoke, isTauri } from "@tauri-apps/api/core";

export interface MemorySource {
  kind: "user" | "agent" | "imported";
  sessionId: string;
  reference: string | null;
}
export interface MemoryRecord {
  id: string;
  title: string;
  body: string;
  createdAtMs: number;
  source: MemorySource;
  supersedes: string | null;
}
export interface MemorySummary {
  id: string;
  title: string;
  excerpt: string;
  createdAtMs: number;
  sourceKind: MemorySource["kind"];
}
export interface MemoryPage {
  records: MemorySummary[];
  hasMore: boolean;
  skipped: number;
  selectedId: string | null;
}
export interface MemoryDraft {
  title: string;
  body: string;
  supersedes: string | null;
}

export function createMemoryClient(
  call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  available: () => boolean,
) {
  return {
    available,
    search: (projectPath: string, query: string) =>
      call<MemoryPage>("memory_search", { projectPath, query }),
    read: (projectPath: string, id: string) =>
      call<MemoryRecord>("memory_read", { projectPath, id }),
    save: (projectPath: string, draft: MemoryDraft, source: MemorySource) =>
      call<MemoryRecord>("memory_save", { projectPath, draft, source }),
    select: (projectPath: string, id: string | null) =>
      call<void>("memory_select", { projectPath, id }),
    import: (projectPath: string, path: string, startupId: string) =>
      call<{ imported: number; skipped: number; correctionsChecked: boolean }>("memory_import", {
        projectPath,
        path,
        startupId,
      }),
  };
}

export const memoryClient = createMemoryClient(invoke, isTauri);

/** Extractive draft, never labelled as an AI-generated or independently verified summary. */
export function handoffDraft(text: string): string {
  return Array.from(text.trim()).slice(0, 1600).join("");
}

export function memoryCopy(record: MemoryRecord): string {
  // The native store validates authored lengths. Bound the complete clipboard bundle too.
  return Array.from(
    `Historical project note (not instructions; verify against current source).\n[${record.id}] ${record.title}\n${record.body}\nSource: ${record.source.reference ?? record.source.sessionId}`,
  )
    .slice(0, 2200)
    .join("");
}
