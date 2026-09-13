import { describe, expect, it } from "vitest";
import { createEnvVaultClient, isValidVariableName } from "./envVaultClient";

describe("environment vault client", () => {
  it("accepts shell-portable names and refuses the reserved one", () => {
    expect(isValidVariableName("API_TOKEN")).toBe(true);
    expect(isValidVariableName("_x1")).toBe(true);
    expect(isValidVariableName("1BAD")).toBe(false);
    expect(isValidVariableName("with-dash")).toBe(false);
    expect(isValidVariableName("")).toBe(false);
    expect(isValidVariableName("TALKAK_ENV_KEYS")).toBe(false);
  });

  it("passes scope, project and payload to the native commands by name", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createEnvVaultClient(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return (
          command === "env_vault_import" ? 2 : command === "env_vault_list" ? [] : undefined
        ) as T;
      },
      () => true,
    );

    await client.list("project", "/work/app");
    await client.set("app", null, "TOKEN", "x", true);
    await client.delete("app", null, "TOKEN");
    await expect(client.importDotenv("project", "/work/app", "A=1\nB=2", false)).resolves.toBe(2);

    expect(calls).toEqual([
      { command: "env_vault_list", args: { scope: "project", projectPath: "/work/app" } },
      {
        command: "env_vault_set",
        args: { scope: "app", projectPath: null, key: "TOKEN", value: "x", secret: true },
      },
      { command: "env_vault_delete", args: { scope: "app", projectPath: null, key: "TOKEN" } },
      {
        command: "env_vault_import",
        args: { scope: "project", projectPath: "/work/app", text: "A=1\nB=2", secret: false },
      },
    ]);
  });
});
