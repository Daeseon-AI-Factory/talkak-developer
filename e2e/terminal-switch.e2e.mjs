import { strict as assert } from "node:assert";
import { isAbsolute } from "node:path";

const projectPath = process.env.TALKAK_MACOS_PROJECT ?? process.env.TALKAK_WINDOWS_PROJECT;
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("Terminal switch E2E needs an absolute external test project");
}

describe("terminal output across a page switch", () => {
  it("commits a delayed write once when foreground and background mounts trade places", async () => {
    await (await $('[data-testid="add-project-global"]')).waitForClickable();
    const existingSessions = new Set(
      (await invoke("session_live")).map((session) => session.sessionId),
    );
    await (await $('[data-testid="add-project-global"]')).click();
    await (await $('[data-testid="project-name"]')).setValue("Switch regression");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();
    await (await $('[data-testid="start-session-in-page"]')).waitForClickable();
    await (await $('[data-testid="start-session-in-page"]')).click();
    await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist();
    let sessionId;
    const createdSessions = new Set();
    try {
      await browser.waitUntil(async () => {
        sessionId = await browser.execute(
          () =>
            window.__talkakTest.retainedTerminalSummary().find((session) => session.foreground)
              ?.sessionId,
        );
        if (sessionId) createdSessions.add(sessionId);
        return Boolean(sessionId);
      });
      await (await $('[data-testid="add-page"]')).click();
      await browser.waitUntil(async () => (await $$('[data-testid="page-tab"]')).length === 2);
      await (await $$('[data-testid="page-tab"]'))[0].click();
      await (await $('[data-testid="live-terminal"]')).waitForExist();
      const snapshot = await invoke("session_snapshot", { request: { sessionId } });
      await browser.waitUntil(async () => (await state(sessionId)).cursor === snapshot.next);
      await browser.execute((id) => window.__talkakTest.holdNextTerminalWrite(id), sessionId);
      // Exercise the actual broker stream. Native write bypasses keyboard synthesis so only
      // output/remount ordering is under test, with the same command on macOS and Windows.
      await invoke("session_write", {
        request: {
          sessionId,
          runId: snapshot.runId,
          data: Buffer.from(`echo switch_probe_${Date.now()}\r`).toString("base64"),
        },
      });
      await browser.waitUntil(async () => (await probe()).held);
      await (await $$('[data-testid="page-tab"]'))[1].click();
      await browser.waitUntil(async () => (await state(sessionId)).connected);
      await (await $$('[data-testid="page-tab"]'))[0].click();
      await (await $('[data-testid="live-terminal"]')).waitForExist();
      // Give both mounts the chance to attach while the first write's cursor is still pending.
      await browser.pause(300);
      await browser.execute(() => window.__talkakTest.releaseHeldTerminalWrite());
      await browser.waitUntil(async () => {
        const snapshot = await invoke("session_snapshot", { request: { sessionId } });
        return (await state(sessionId)).cursor === snapshot.next;
      });
      const written = await probe();
      const end = await state(sessionId);
      const brokerBytes = end.cursor - written.startCursor;
      console.log(
        `TERMINAL_SWITCH_BYTES ${JSON.stringify({ brokerBytes, paintedBytes: written.bytesWritten })}`,
      );
      assert.equal(
        written.bytesWritten,
        brokerBytes,
        "Page switch replayed bytes already painted by the previous mount",
      );
    } finally {
      await browser.execute(() => window.__talkakTest.stopTerminalWriteProbe());
      for (const item of await browser.execute(() =>
        window.__talkakTest.retainedTerminalSummary(),
      )) {
        if (!existingSessions.has(item.sessionId)) createdSessions.add(item.sessionId);
      }
      const sessions = await invoke("session_live");
      for (const session of sessions) {
        if (createdSessions.has(session.sessionId) && session.running) {
          await invoke("session_kill", {
            request: { sessionId: session.sessionId, runId: session.runId },
          });
        }
      }
    }
  });
});

async function invoke(command, args = {}) {
  return browser.execute((name, input) => window.__TAURI__.core.invoke(name, input), command, args);
}
async function state(sessionId) {
  return browser.execute(
    (id) => window.__talkakTest.retainedTerminalSummary().find((s) => s.sessionId === id),
    sessionId,
  );
}
async function probe() {
  return browser.execute(() => window.__talkakTest.terminalWriteProbe());
}
