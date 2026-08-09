import { describe, expect, it } from "vitest";
import { createProjectClient } from "./projectClient";
import type { InvokeCommand } from "./sessionClient";

describe("project client", () => {
  it("uses the typed project path command boundary", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const invokeCommand: InvokeCommand = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      return { valid: true, reason: null } as T;
    };
    const client = createProjectClient(invokeCommand, () => true);

    await expect(client.validatePath("C:\\work\\app")).resolves.toEqual({
      valid: true,
      reason: null,
    });
    expect(calls).toEqual([{ command: "project_validate_path", args: { path: "C:\\work\\app" } }]);
  });
});
