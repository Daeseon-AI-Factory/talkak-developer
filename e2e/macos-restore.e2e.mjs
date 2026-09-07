// Restore after broker loss, on the built macOS test app: a live session survives the broker
// being killed with SIGKILL and the app reloading — same pane, old output, a divider, the agent
// resume line typed once from a persisted binding — and a session the user stopped stays stopped.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Key } from "webdriverio";

const projectPath = process.env.TALKAK_MACOS_PROJECT;
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("TALKAK_MACOS_PROJECT must be an absolute external test directory.");
}
const sessionsDir = join(
  homedir(),
  "Library/Application Support/dev.talkak.desktop.macosci/sessions",
);

async function invokeApp(command, args = {}) {
  return browser.execute(
    async (tauriCommand, tauriArgs) => window.__TAURI_INTERNALS__.invoke(tauriCommand, tauriArgs),
    command,
    args,
  );
}

async function terminalText() {
  const lines = await browser.execute(() => window.__talkakTest?.liveTerminalLines() ?? []);
  return lines.join("\n");
}

async function paste(text) {
  await invokeApp("clipboard_write_text", { text });
  const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
  await input.waitForExist();
  await input.click();
  await browser.keys([Key.Command, "v"]);
  await browser.keys(Key.Enter);
}

/** SIGKILL every broker of the test identifier: no shutdown, no exit marks, like a crash. */
function killBroker() {
  const out = execSync('pgrep -f "dev.talkak.desktop.macosci/broker/talkak-dev-broker-" || true')
    .toString()
    .trim();
  const pids = out.split(/\s+/).filter(Boolean);
  for (const pid of pids) execSync(`kill -9 ${pid}`);
  return pids;
}

const hex = (text) => Buffer.from(text, "utf8").toString("hex");

describe("session restore after broker loss", () => {
  it("brings a live session back with its output and resumes its agent once", async () => {
    await (await $('[data-testid="add-project-global"]')).waitForExist();
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem(
        "talkak.resilience.v1",
        JSON.stringify({
          brokerAutostart: false,
          recipes: { claude: "echo resumed-{id}", codex: "", antigravity: "" },
        }),
      );
    });
    await browser.refresh();
    const addProject = await $('[data-testid="add-project-global"]');
    await addProject.waitForClickable();
    await addProject.click();
    await (await $('[data-testid="project-name"]')).setValue("restore");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();
    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    await startSession.click();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 20_000,
    });
    await browser.pause(1000);
    await paste("echo before-restore-marker");
    await browser.waitUntil(async () => (await terminalText()).includes("before-restore-marker"), {
      timeout: 20_000,
      timeoutMsg: "the marker never echoed before the broker was killed",
    });

    const live = await invokeApp("session_live");
    const session = live.find((entry) => entry.running);
    const runBefore = session.runId;
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${hex(session.sessionId)}.bind`),
      JSON.stringify({
        source: "claude",
        recordPath: "/nowhere/abc123.jsonl",
        recordId: "abc123",
        boundAtMs: 1,
      }),
    );

    if (killBroker().length === 0) throw new Error("no broker process found to kill");
    await browser.pause(1500);
    await browser.refresh();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 30_000,
      timeoutMsg: "the session did not come back after the broker died",
    });
    await browser.waitUntil(async () => (await terminalText()).includes("resumed-abc123"), {
      timeout: 30_000,
      timeoutMsg: "the resume line from the binding was never typed",
    });
    const text = await terminalText();
    const marker = text.indexOf("before-restore-marker");
    const divider = text.indexOf("session restored");
    if (marker < 0 || divider < marker) {
      throw new Error(`old output and divider out of order: ${text.slice(-300)}`);
    }
    const restored = (await invokeApp("session_live")).find(
      (entry) => entry.sessionId === session.sessionId,
    );
    if (!restored?.running || restored.runId <= runBefore) {
      throw new Error(`the session did not come back under its id: ${JSON.stringify(restored)}`);
    }

    // A reload without a broker loss resumes nothing more.
    await browser.refresh();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
      timeout: 20_000,
    });
    await browser.pause(2000);
    const typed = ((await terminalText()).match(/echo resumed-abc123/g) ?? []).length;
    if (typed !== 1) throw new Error(`the resume line was typed ${typed} times`);

    // Stopped on purpose: a broker loss must not bring it back.
    await (await $('[data-testid="stop-session"]')).click();
    const confirm = await $(".confirm-dialog__actions button:first-child");
    await confirm.waitForClickable();
    await confirm.click();
    await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist({
      timeout: 20_000,
    });
    await browser.pause(1500);
    if (killBroker().length === 0) throw new Error("no broker process found to kill (second)");
    await browser.pause(1500);
    await browser.refresh();
    await browser.pause(4000);
    const back = (await invokeApp("session_live")).find(
      (entry) => entry.sessionId === session.sessionId,
    );
    if (back?.running) throw new Error("a stopped session was resurrected");
  });
});
