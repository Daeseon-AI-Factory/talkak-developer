// The push-based terminal transport, end to end in the built macOS app: output arrives without a
// poll, a 40 000-line burst lands whole, a page switch neither replays nor drops bytes, the
// inspector's log streams the same session, and a restart starts from a clean screen. Timings are
// logged for the record; only the ordering and completeness are asserted.
import { strict as assert } from "node:assert";
import { isAbsolute } from "node:path";
import { Key } from "webdriverio";

const projectPath = process.env.TALKAK_MACOS_PROJECT;
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("TALKAK_MACOS_PROJECT must be an absolute external test directory.");
}

const timings = {};

describe("streamed terminal output", () => {
  it("echoes, streams heavy output, survives a page switch without duplicates, logs, restarts", async () => {
    await (await $('[data-testid="add-project-global"]')).waitForExist();
    await browser.execute(() => localStorage.clear());
    await browser.refresh();

    const addProject = await $('[data-testid="add-project-global"]');
    await addProject.waitForClickable();
    await addProject.click();
    await (await $('[data-testid="project-name"]')).setValue("stream check");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();

    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    const startedAt = Date.now();
    await startSession.click();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 20_000,
    });
    timings.startToRunningMs = Date.now() - startedAt;

    // 1. A command's output arrives.
    const one = marker("talkakstreamone");
    await typeCommand(`printf '${one.octal}'`);
    timings.firstOutputMs = await waitForText(one.text, "first command output never arrived");

    // 2. Heavy output: 40 000 lines, then a marker. Old path: 64 KiB per poll round-trip.
    const heavy = marker("talkakheavydone");
    const heavyStarted = Date.now();
    await typeCommand(`seq 1 40000; printf '${heavy.octal}'`);
    timings.heavy40kLinesMs = await waitForText(heavy.text, "heavy output never finished", 60_000);
    timings.heavy40kLinesFromEnterMs = Date.now() - heavyStarted;

    // 3. Pasted input echoes back (WebDriver round-trips included, so an upper bound).
    const echo = "talkakecho";
    // `: <word>` is the shell's no-op, so the line can be run and leaves nothing behind.
    await invokeApp("clipboard_write_text", { text: `: ${echo}` });
    const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
    await input.click();
    const echoStarted = Date.now();
    await browser.keys([Key.Command, "v"]);
    await browser.waitUntil(async () => (await terminalText()).includes(echo), {
      timeout: 10_000,
      timeoutMsg: "pasted input never echoed",
    });
    timings.inputEchoMs = Date.now() - echoStarted;
    await browser.keys(Key.Enter);

    // 4. Page switch away and back: the retained emulator must not replay or duplicate.
    await (await $('[data-testid="add-page"]')).click();
    await browser.waitUntil(async () => (await $$('[data-testid="page-tab"]')).length === 2, {
      timeout: 10_000,
    });
    await browser.pause(300);
    await (await $$('[data-testid="page-tab"]'))[0].click();
    await (await $('[data-testid="live-terminal"]')).waitForExist({ timeout: 10_000 });
    const after = marker("talkakafterswitch");
    await typeCommand(`printf '${after.octal}'`);
    timings.afterSwitchOutputMs = await waitForText(after.text, "output after page switch missing");
    const rows = await terminalText();
    assert.equal(count(rows, after.text), 1, `marker painted ${count(rows, after.text)} times`);
    assert.equal(count(rows, heavy.text), 1, "heavy marker was replayed after the page switch");

    // 5. Natural exit → Attention → the retained terminal log shows what the pane showed.
    await typeCommand("exit");
    await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist({
      timeout: 20_000,
    });
    await (await $('[data-testid="nav-attention"]')).click();
    await browser.waitUntil(
      async () => (await $$('[data-testid="runtime-attention-card"]')).length === 1,
      { timeout: 20_000, timeoutMsg: "the exit never reached Attention" },
    );
    await (await $('[data-testid="runtime-attention-card"]')).click();
    await (await $('[data-testid="open-runtime-terminal"]')).click();
    const terminalLog = await $('[data-testid="terminal-log-view"]');
    await terminalLog.waitForExist();
    await (await terminalLog.$('[data-phase="exited"]')).waitForExist({ timeout: 20_000 });
    await browser.waitUntil(async () => (await logText()).includes(after.text), {
      timeout: 20_000,
      timeoutMsg: "the terminal log did not stream the session's output",
    });

    // 6. Restart the session from the exited pane and get a live shell again. The unpinned
    // inspector sits on a backdrop over the workspace; a press on the backdrop closes it.
    await browser.execute(() => {
      document
        .querySelector(".inspector-backdrop")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await $$(".inspector-backdrop")).length === 0, {
      timeout: 5_000,
      timeoutMsg: "the inspector backdrop never closed",
    });
    await (await $$('[data-testid="page-tab"]'))[0].click();
    await browser.pause(1500);
    const restartState = await browser.execute(() => ({
      restart: [...document.querySelectorAll(".terminal-restart")].map((b) => ({
        disabled: b.disabled,
        title: b.title,
        text: b.textContent,
      })),
      phases: [...document.querySelectorAll('[data-testid="runtime-phase"]')].map((e) =>
        e.getAttribute("data-phase"),
      ),
      backdrop: document.querySelectorAll(".inspector-backdrop").length,
      inspector: document.querySelectorAll(".inspector").length,
      launcher: document.querySelectorAll(".terminal-launcher").length,
      errors: [...document.querySelectorAll(".terminal-runtime-error")].map((e) => e.textContent),
      retained: window.__talkakTest.retainedTerminalSummary(),
    }));
    console.log(`TALKAK_RESTART_STATE ${JSON.stringify(restartState)}`);
    const restart = await $(".terminal-restart");
    await restart.waitForClickable({ timeout: 20_000 });
    await restart.click();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 20_000,
    });
    const second = marker("talkaksecondrun");
    await typeCommand(`printf '${second.octal}'`);
    await waitForText(second.text, "the restarted run produced no output");
    const restartedRows = await terminalText();
    assert.equal(
      count(restartedRows, after.text),
      0,
      "the old run's screen leaked into the new one",
    );

    await stopRunningSession();
    console.log(`TALKAK_STREAM_TIMINGS ${JSON.stringify(timings)}`);
  });
});

function marker(text) {
  const octal = [...`${text}\n`]
    .map((character) => `\\${character.codePointAt(0).toString(8).padStart(3, "0")}`)
    .join("");
  return { text, octal };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Commands are PASTED, not typed. WebDriver on WebKit synthesises keydown + a non-composed input
 * event and no keypress, and xterm then emits every character twice — a harness artefact a real
 * keyboard never produces (it fires keypress, which xterm uses to de-duplicate). The product's own
 * macOS gate pastes for the same reason.
 */
async function typeCommand(command) {
  await invokeApp("clipboard_write_text", { text: command });
  const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
  await input.waitForExist();
  await input.click();
  await browser.keys([Key.Command, "v"]);
  await browser.keys(Key.Enter);
}

async function invokeApp(command, args = {}) {
  return browser.execute(
    async (tauriCommand, tauriArgs) => window.__TAURI_INTERNALS__.invoke(tauriCommand, tauriArgs),
    command,
    args,
  );
}

async function waitForText(text, message, timeout = 20_000) {
  const started = Date.now();
  await browser.waitUntil(async () => (await terminalText()).includes(text), {
    timeout,
    interval: 25,
    timeoutMsg: message,
  });
  return Date.now() - started;
}

async function terminalText() {
  const lines = await browser.execute(() => window.__talkakTest?.liveTerminalLines() ?? []);
  return lines.join("\n");
}

async function logText() {
  const lines = await browser.execute(() => window.__talkakTest?.terminalLogLines() ?? []);
  return lines.join("\n");
}

async function stopRunningSession() {
  const running = await $$('[data-testid="runtime-phase"][data-phase="running"]');
  if (running.length === 0) return;
  await (await $('[data-testid="stop-session"]')).click();
  const confirmation = await $("dialog[open].confirm-dialog");
  await confirmation.waitForExist();
  await (await confirmation.$('button[data-tone="danger"]')).click();
  await browser.waitUntil(async () => (await running[0].getAttribute("data-phase")) === "exited", {
    timeout: 20_000,
    timeoutMsg: "cleanup did not stop the PTY session",
  });
}
