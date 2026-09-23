import { describe, expect, it, vi } from "vitest";
import { createLocalProject, readStoredProjects, writeStoredProjects } from "../projectStore";
import { createMemoryClient, handoffDraft, memoryCopy } from "./memoryClient";
import { createSessionSpawnInput } from "./sessionLaunch";

describe("project memory integration", () => {
  it("keeps the explicit adapter through project persistence and passes it only to configured sessions", () => {
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    };
    for (const memory of ["mcp-json", "mcp-toml"] as const) {
      const project = createLocalProject({
        name: "Memory",
        path: "C:\\projects\\app",
        description: "",
        launchProfile: {
          label: "My agent",
          command: "a-user-chosen-agent",
          args: ["--model", "user-model"],
          memory,
        },
      });
      writeStoredProjects(storage, [project]);
      const restored = readStoredProjects(storage)[0];
      const request = createSessionSpawnInput("s", restored.path, restored.launchProfile);
      expect(request.memory).toBe(memory);
      expect(request.command).toBe("a-user-chosen-agent");
      expect(request.args).toEqual(["--model", "user-model"]);
      expect(
        createSessionSpawnInput("s", "", { ...restored.launchProfile, command: null }).memory,
      ).toBeUndefined();
    }
  });

  it("does not silently enable a memory connection in existing profiles", () => {
    expect(
      createSessionSpawnInput("s", "/project", { label: "Agent", command: "custom", args: [] }),
    ).not.toHaveProperty("memory");
  });

  it("preserves an explicit opt-out across reloads and adapter changes without losing user arguments", () => {
    let saved: string | null = null;
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };
    const project = createLocalProject({
      name: "My project",
      description: "",
      path: "/projects/app",
      launchProfile: {
        label: "Configured agent",
        command: "custom-executable",
        args: ["--model", "my-model", "--user-option"],
        memory: "mcp-json",
        memoryEnabled: false,
      },
    });
    writeStoredProjects(storage, [project]);
    const restored = readStoredProjects(storage)[0];
    expect(restored.launchProfile.memory).toBe("mcp-json");
    expect(restored.launchProfile.memoryEnabled).toBe(false);
    restored.launchProfile.memory = "mcp-toml";
    writeStoredProjects(storage, [restored]);
    const profile = readStoredProjects(storage)[0].launchProfile;
    const request = createSessionSpawnInput("s", restored.path, profile);
    expect(request.memory).toBe("mcp-toml");
    expect(request.memoryEnabled).toBe(false);
    expect(request.args).toEqual(project.launchProfile.args);
    expect(request.command).toBe("custom-executable");
    expect(
      createSessionSpawnInput("s", restored.path, { ...profile, memoryEnabled: true }).memory,
    ).toBe("mcp-toml");
    expect(profile.memoryEnabled).toBe(false);
    expect(
      createSessionSpawnInput("s", restored.path, { ...profile, memory: undefined }),
    ).not.toHaveProperty("memory");
  });

  it("sends the exact project scope for reads, corrections, and handoff selection", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const client = createMemoryClient(invoke, () => true);
    await client.save(
      "/project A",
      { title: "Decision", body: "Current choice", supersedes: "abc" },
      {
        kind: "user",
        sessionId: "s",
        reference: "record.jsonl",
      },
    );
    await client.read("/project B", "def");
    await client.select("/project A", null);
    expect(invoke.mock.calls.map(([, args]) => args.projectPath)).toEqual([
      "/project A",
      "/project B",
      "/project A",
    ]);
    expect(invoke.mock.calls[0][1].draft.supersedes).toBe("abc");
    expect(invoke.mock.calls[2][1].id).toBeNull();
  });

  it("bounds drafts without splitting emoji and labels copied memory as historical data", () => {
    const draft = handoffDraft("😀".repeat(1700));
    expect(Array.from(draft)).toHaveLength(1600);
    expect(draft).not.toContain("\uFFFD");
    const copy = memoryCopy({
      id: "abc",
      title: "Choice",
      body: draft,
      createdAtMs: 0,
      supersedes: null,
      source: { kind: "agent", sessionId: "s", reference: "/records/source.jsonl" },
    });
    expect(copy).toContain("Historical project note");
    expect(copy).toContain("[abc]");
    expect(copy).toContain("/records/source.jsonl");
    expect(Array.from(copy).length).toBeLessThanOrEqual(2200);
  });
});
