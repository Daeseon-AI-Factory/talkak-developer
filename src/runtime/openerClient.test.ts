import { describe, expect, it } from "vitest";
import { createOpenerClient, isExternalWebUrl } from "./openerClient";

describe("opener client", () => {
  it("recognises only absolute http and https URLs", () => {
    expect(isExternalWebUrl("https://example.com/path?x=1")).toBe(true);
    expect(isExternalWebUrl("  http://example.com ")).toBe(true);
    expect(isExternalWebUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalWebUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalWebUrl("mailto:someone@example.com")).toBe(false);
    expect(isExternalWebUrl("example.com")).toBe(false);
    expect(isExternalWebUrl("https://")).toBe(false);
    expect(isExternalWebUrl("")).toBe(false);
  });

  it("opens only web URLs, and only in the desktop app", async () => {
    const opened: string[] = [];
    const revealed: string[] = [];
    let loads = 0;
    const plugin = {
      openUrl: async (url: string) => {
        opened.push(url);
      },
      revealItemInDir: async (path: string) => {
        revealed.push(path);
      },
    };
    const desktop = createOpenerClient(
      () => true,
      async () => {
        loads += 1;
        return plugin;
      },
    );
    await expect(desktop.openExternalUrl(" https://example.com ")).resolves.toBe(true);
    await expect(desktop.openExternalUrl("file:///tmp")).resolves.toBe(false);
    expect(opened).toEqual(["https://example.com"]);
    await desktop.revealPath("/projects/app");
    expect(revealed).toEqual(["/projects/app"]);
    expect(loads).toBe(2);

    const browser = createOpenerClient(
      () => false,
      async () => {
        throw new Error("the plugin must not load outside the desktop app");
      },
    );
    await expect(browser.openExternalUrl("https://example.com")).resolves.toBe(false);
    await expect(browser.revealPath("/projects/app")).rejects.toThrow(/desktop app/);
  });
});
