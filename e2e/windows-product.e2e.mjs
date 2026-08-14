import { strict as assert } from "node:assert";
import { isAbsolute } from "node:path";
import { Key } from "webdriverio";

const marker = "TALKAK_WINDOWS_PTY_OK";
const markerCommand = "echo TALKAK_WINDOWS_PTY_^OK";
const projectPath = process.env.TALKAK_WINDOWS_PROJECT;
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("TALKAK_WINDOWS_PROJECT must be an absolute external test directory.");
}

describe("installed Windows product path", () => {
  it("creates a project, starts a session, exchanges PTY data, splits, and adds a page", async () => {
    await browser.execute(() => {
      localStorage.clear();
    });
    await browser.refresh();

    const addProject = await $('[data-testid="add-project"]');
    await addProject.waitForClickable();
    await addProject.click();

    await (await $('[data-testid="project-name"]')).setValue("Windows CI");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();

    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    await startSession.click();
    await waitForRunningTerminalCount(1);

    const terminalScreen = await $('[data-testid="live-terminal"] .xterm-screen');
    await terminalScreen.waitForClickable();
    await terminalScreen.click();
    await pasteTerminalCommand(markerCommand);

    await browser.waitUntil(async () => (await terminalText()).includes(marker), {
      timeout: 20_000,
      timeoutMsg: `PTY did not echo ${marker}`,
    });

    await (await $('[data-testid="split-right"]')).click();
    await waitForRunningTerminalCount(2);

    await (await $('[data-testid="add-page"]')).click();
    await browser.waitUntil(async () => (await $$('[data-testid="page-tab"]')).length === 2, {
      timeout: 20_000,
      timeoutMsg: "A second workspace page was not created",
    });
    await waitForRunningTerminalCount(1);

    assert.equal((await $$('[data-testid="page-tab"]')).length, 2);
    assert.equal((await $$('[data-testid="live-terminal"]')).length, 1);

    await stopVisibleSessions();
    await (await $$('[data-testid="page-tab"]'))[0].click();
    await waitForRunningTerminalCount(2);
    await stopVisibleSessions();
  });
});

async function waitForRunningTerminalCount(expected) {
  await browser.waitUntil(
    async () =>
      (await $$('[data-testid="runtime-phase"][data-phase="running"]')).length === expected,
    { timeout: 20_000, timeoutMsg: `Expected ${expected} running terminal pane(s)` },
  );
}

async function stopVisibleSessions() {
  while ((await $$('[data-testid="runtime-phase"][data-phase="running"]')).length > 0) {
    const stop = (await $$('[data-testid="stop-session"]'))[0];
    const pane = await stop.$("./ancestor::article[1]");
    const phase = await pane.$('[data-testid="runtime-phase"]');
    await stop.click();
    await browser.waitUntil(async () => (await phase.getAttribute("data-phase")) === "exited", {
      timeout: 20_000,
      timeoutMsg: "A PTY session did not report an exited runtime",
    });
  }
}

async function terminalText() {
  const rows = await $$('[data-testid="live-terminal"] .xterm-rows');
  const text = await rows.map((row) => row.getText());
  return text.join("\n");
}

async function pasteTerminalCommand(command) {
  const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
  await input.waitForExist();
  await input.addValue(command);
  await browser.keys(Key.Enter);
}
