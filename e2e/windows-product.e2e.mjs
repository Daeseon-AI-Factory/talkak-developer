import { strict as assert } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Key } from "webdriverio";
import { verifyMultilineDragAutoCopy } from "./terminal-drag-copy.e2e-helper.mjs";

const windowsIdentity = execFileSync("whoami.exe", { encoding: "utf8" }).trim();
const projectPath = process.env.TALKAK_WINDOWS_PROJECT;
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("TALKAK_WINDOWS_PROJECT must be an absolute external test directory.");
}

describe("installed Windows product path", () => {
  it("exercises PTYs, terminal clipboard, pages, runtime status, and Attention", async () => {
    await (await $('[data-testid="add-project-global"]')).waitForExist();
    await browser.execute(() => {
      localStorage.clear();
    });
    await browser.refresh();

    const addProject = await $('[data-testid="add-project-global"]');
    await addProject.waitForClickable();
    await addProject.click();

    await (await $('[data-testid="project-name"]')).setValue("Windows CI");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();

    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    await startSession.click();
    await waitForRunningTerminalCount(1);

    await typeTerminalCommand("whoami");

    await browser.waitUntil(async () => (await terminalText()).includes(windowsIdentity), {
      timeout: 20_000,
      timeoutMsg: "PTY did not report the current Windows identity",
    });
    await verifyPlainCtrlVPaste();
    await verifyMultilineDragAutoCopy({
      command: "write-output 'talkakcopylineone','talkakcopylinetwo','talkakcopylinethree'",
      pasteChord: [Key.Control, "v"],
      lineEnding: "\r\n",
      // A local verification cannot restore image pixels. Hosted CI has a text clipboard.
      skipImageClipboard: true,
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
    const pageNavigation = await browser.execute(() => ({
      tabListWidth: document.querySelector(".page-tabs")?.getBoundingClientRect().width ?? 0,
      inlineShortcutCount: document.querySelectorAll(".workspace-toolbar--pages kbd").length,
      addButtonIsPinned:
        document
          .querySelector('[data-testid="add-page"]')
          ?.parentElement?.classList.contains("page-tabs-shell") ?? false,
    }));
    assert.ok(pageNavigation.tabListWidth >= 96, "Page tabs must retain one visible tab width");
    assert.equal(pageNavigation.inlineShortcutCount, 0);
    assert.equal(pageNavigation.addButtonIsPinned, true);

    await typeTerminalCommand("whoami");
    await browser.waitUntil(async () => (await terminalText()).includes(windowsIdentity), {
      timeout: 20_000,
      timeoutMsg: "The Attention probe did not report the current Windows identity",
    });
    await exitVisibleSession();
    await (await $('[data-testid="nav-attention"]')).click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="runtime-attention-card"]')).length === 1,
      { timeout: 20_000, timeoutMsg: "The observed PTY exit did not reach Attention" },
    );
    await (await $('[data-testid="runtime-attention-card"]')).click();
    await (await $('[data-testid="open-runtime-terminal"]')).click();
    const terminalLog = await $('[data-testid="terminal-log-view"]');
    await terminalLog.waitForExist();
    await (await terminalLog.$('[data-phase="exited"]')).waitForExist({ timeout: 20_000 });
    await browser.waitUntil(async () => (await terminalLogText()).includes(windowsIdentity), {
      timeout: 20_000,
      timeoutMsg: "Terminal log did not retain the current Windows identity",
    });

    await (await $$('[data-testid="page-tab"]'))[0].click();
    await waitForRunningTerminalCount(2);
    await stopVisibleSessions();

    await (await $('[data-testid="nav-sessions"]')).click();
    await browser.waitUntil(
      async () =>
        (await $$('[data-testid="session-runtime-status"][data-runtime-phase="exited"]')).length ===
        3,
      { timeout: 20_000, timeoutMsg: "Sessions did not retain three exited PTY statuses" },
    );
    await (await $('[data-testid="nav-attention"]')).click();
    const remainingNotice = await $$('[data-testid="runtime-attention-card"]');
    assert.equal(remainingNotice.length, 1);
    await remainingNotice[0].click();
    const attentionList = await $('[data-testid="attention-list"]');
    await (await $('[data-testid="ack-runtime-notice"]')).click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="runtime-attention-card"]')).length === 0,
      { timeout: 20_000, timeoutMsg: "The reviewed PTY notice did not leave Attention" },
    );
    await browser.waitUntil(async () => attentionList.isFocused(), {
      timeout: 20_000,
      timeoutMsg: "Attention focus did not return to the item list after review",
    });
  });

  it("brings a live session back after the broker dies and leaves a stopped one alone", async () => {
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem(
        "talkak.resilience.v1",
        JSON.stringify({
          brokerAutostart: false,
          recipes: { claude: "write-output resumed-{id}", codex: "", antigravity: "" },
        }),
      );
    });
    await browser.refresh();
    const addProject = await $('[data-testid="add-project-global"]');
    await addProject.waitForClickable();
    await addProject.click();
    await (await $('[data-testid="project-name"]')).setValue("Windows restore");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();
    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    await startSession.click();
    await waitForRunningTerminalCount(1);
    await pasteCommand("write-output beforerestoremarker");
    await browser.waitUntil(async () => (await terminalText()).includes("beforerestoremarker"), {
      timeout: 20_000,
      timeoutMsg: "the marker never echoed before the broker was killed",
    });

    // The broker still holds the sessions the first scenario left running, so ask the app which
    // session the mounted pane is showing rather than taking the first running one.
    const summary = await browser.execute(() => window.__talkakTest.retainedTerminalSummary());
    const shown = summary.find((entry) => entry.connected);
    assert.ok(shown, "no mounted terminal to restore");
    const session = (await invokeApp("session_live")).find(
      (entry) => entry.sessionId === shown.sessionId,
    );
    assert.ok(session?.running, "the mounted pane's session is not running");
    const runBefore = session.runId;
    // The store's path is the app's to know: this build has no identifier of its own, and the
    // guessed path wrote an earlier binding where nothing would ever read it.
    const sessionsDir = await invokeApp("session_store_dir");
    assert.ok(sessionsDir, "the app reported no session store");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      `${sessionsDir}\\${Buffer.from(session.sessionId, "utf8").toString("hex")}.bind`,
      JSON.stringify({
        source: "claude",
        recordPath: "C:\\nowhere\\abc123.jsonl",
        recordId: "abc123",
        boundAtMs: 1,
      }),
    );

    assert.ok(killBroker() >= 1, "no broker process found to kill");
    await browser.pause(2000);
    await browser.refresh();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 40_000,
      timeoutMsg: "the session did not come back after the broker died",
    });
    await browser.waitUntil(async () => (await timesResumed("resumed-abc123")) === 1, {
      timeout: 40_000,
      timeoutMsg: "the resume command from the binding never ran in the restored shell",
    });
    // What the pane showed before the restore lives in the record, not necessarily on screen: a
    // PowerShell started under ConPTY clears the screen and its scrollback as it comes up, so the
    // restored pane starts clean here where a macOS shell keeps the old lines above the divider.
    const stored = Buffer.from(
      await invokeApp("session_stored_output", { request: { sessionId: session.sessionId } }),
      "base64",
    ).toString("utf8");
    const marker = stored.indexOf("beforerestoremarker");
    const divider = stored.indexOf("session restored");
    assert.ok(
      marker >= 0 && divider > marker,
      `the record lost what came before the restore: ${stored.slice(-300)}`,
    );
    const restored = (await invokeApp("session_live")).find(
      (entry) => entry.sessionId === session.sessionId,
    );
    assert.ok(
      restored?.running && restored.runId > runBefore,
      "the session did not come back under its id",
    );

    await browser.refresh();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 20_000,
    });
    await browser.pause(2000);
    assert.equal(
      await timesResumed("resumed-abc123"),
      1,
      "the resume command must run exactly once",
    );

    await (await $('[data-testid="stop-session"]')).click();
    const confirm = await $(".confirm-dialog__actions button:first-child");
    await confirm.waitForClickable();
    await confirm.click();
    await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist({
      timeout: 20_000,
    });
    await browser.pause(2000);
    assert.ok(killBroker() >= 1, "no broker process found to kill (second)");
    await browser.pause(2000);
    await browser.refresh();
    await browser.pause(5000);
    const back = (await invokeApp("session_live")).find(
      (entry) => entry.sessionId === session.sessionId,
    );
    assert.ok(!back?.running, "a stopped session was resurrected");
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
    const confirmation = await $("dialog[open].confirm-dialog");
    await confirmation.waitForExist();
    await (await confirmation.$('button[data-tone="danger"]')).click();
    await browser.waitUntil(async () => (await phase.getAttribute("data-phase")) === "exited", {
      timeout: 20_000,
      timeoutMsg: "A PTY session did not report an exited runtime",
    });
  }
}

/**
 * SIGKILL's Windows cousin: no shutdown, no exit marks on the store, like a crash. Returns how
 * many brokers were killed — `taskkill` with a filter reports success when nothing matched, so a
 * pattern that stopped matching would have read as a kill and hidden the test that follows.
 */
function killBroker() {
  const killed = execSync(
    'powershell -NoProfile -Command "$p = @(Get-Process talkak-dev-broker-* -ErrorAction SilentlyContinue); $p | Stop-Process -Force; $p.Count"',
    { encoding: "utf8" },
  ).trim();
  return Number.parseInt(killed, 10) || 0;
}

async function pasteCommand(command) {
  await invokeApp("clipboard_write_text", { text: command });
  const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
  await input.waitForExist();
  await input.click();
  await browser.keys([Key.Control, "v"]);
  await browser.keys(Key.Enter);
}

async function exitVisibleSession() {
  const phase = await $('[data-testid="runtime-phase"]');
  await typeTerminalCommand("exit");
  await browser.waitUntil(async () => (await phase.getAttribute("data-phase")) === "exited", {
    timeout: 20_000,
    timeoutMsg: "A naturally exited PTY did not report its final runtime status",
  });
}

async function terminalText() {
  const lines = await browser.execute(() => window.__talkakTest?.liveTerminalLines() ?? []);
  return lines.join("\n");
}

/**
 * How many times the resume command actually RAN: its output, alone on a line. The typed line is
 * echoed once by the terminal and redrawn once by the shell when it starts reading, so counting
 * the command text counts a single resume twice.
 */
async function timesResumed(marker) {
  const lines = await browser.execute(() => window.__talkakTest?.liveTerminalLines() ?? []);
  return lines.filter((line) => line.trim() === marker).length;
}

async function terminalLogText() {
  const lines = await browser.execute(() => window.__talkakTest?.terminalLogLines() ?? []);
  return lines.join("\n");
}

async function typeTerminalCommand(command) {
  if (!/^[a-z]+$/u.test(command)) {
    throw new Error("The embedded terminal key probe only accepts lowercase ASCII letters.");
  }
  const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
  await input.waitForExist();
  await input.click();
  await input.addValue(command);
  await browser.keys(Key.Enter);
}

async function verifyPlainCtrlVPaste() {
  const imagePath = await invokeApp("clipboard_read_image_path");
  // Replacing an image with test text would destroy user clipboard data on a local verification
  // run. CI has no image, while a developer with a screenshot gets a safe skip.
  if (imagePath !== null) return;

  const originalText = await invokeApp("clipboard_read_text");
  const marker = "talkakplainctrlvpaste";
  const charCodes = [...marker].map((character) => character.codePointAt(0)).join(",");
  // The expected marker is not present in the typed command, so seeing it proves Enter executed
  // the pasted PowerShell rather than merely echoing the command line into xterm.
  const command = `write-output (-join (${charCodes} | % {[char]$_}))`;
  try {
    await invokeApp("clipboard_write_text", { text: command });
    const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
    await input.waitForExist();
    await input.click();
    await browser.keys([Key.Control, "v"]);
    await browser.waitUntil(async () => (await terminalText()).includes("write-output"), {
      timeout: 20_000,
      timeoutMsg: "Ctrl+V did not deliver clipboard text to the PTY before Enter",
    });
    await browser.keys(Key.Enter);
    await browser.waitUntil(async () => (await terminalText()).includes(marker), {
      timeout: 20_000,
      timeoutMsg: "Plain Ctrl+V did not paste through the app clipboard path",
    });
  } finally {
    await invokeApp("clipboard_write_text", { text: originalText });
  }
}

async function invokeApp(command, args = {}) {
  return browser.execute(
    async (tauriCommand, tauriArgs) => window.__TAURI_INTERNALS__.invoke(tauriCommand, tauriArgs),
    command,
    args,
  );
}
