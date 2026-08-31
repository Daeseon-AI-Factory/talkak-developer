import { strict as assert } from "node:assert";
import { isAbsolute } from "node:path";
import { Key } from "webdriverio";

const projectPath = process.env.TALKAK_MACOS_PROJECT;
if (process.platform !== "darwin") {
  throw new Error("The macOS product E2E suite must run on a native macOS host.");
}
if (!projectPath || !isAbsolute(projectPath)) {
  throw new Error("TALKAK_MACOS_PROJECT must be an absolute external test directory.");
}

describe("built macOS product path", () => {
  it("pastes native clipboard text into a real PTY with Command+V", async () => {
    await browser.execute(() => {
      localStorage.clear();
    });
    await browser.refresh();

    const addProject = await $('[data-testid="add-project-global"]');
    await addProject.waitForClickable();
    await addProject.click();
    await (await $('[data-testid="project-name"]')).setValue("macOS CI");
    await (await $('[data-testid="project-path"]')).setValue(projectPath);
    await (await $('[data-testid="save-project"]')).click();

    const startSession = await $('[data-testid="start-session-in-page"]');
    await startSession.waitForClickable();
    await startSession.click();
    try {
      await (await $('[data-testid="runtime-phase"][data-phase="running"]')).waitForExist({
        timeout: 20_000,
      });
      await verifyPlainCommandVPaste();
    } finally {
      await stopRunningSession();
    }
  });
});

async function verifyPlainCommandVPaste() {
  const imagePath = await invokeApp("clipboard_read_image_path");
  assert.equal(
    imagePath,
    null,
    "Refusing to replace an image clipboard that cannot be restored as text",
  );

  const originalText = await invokeApp("clipboard_read_text");
  const marker = "talkakplaincommandvpaste";
  const octalMarker = [...`${marker}\n`]
    .map((character) => `\\${character.codePointAt(0).toString(8).padStart(3, "0")}`)
    .join("");
  // The literal marker is absent from the command. It appears only if the pasted shell command
  // executes, so xterm merely echoing the input cannot satisfy the assertion.
  const command = `printf '${octalMarker}'; exit`;

  try {
    await invokeApp("clipboard_write_text", { text: command });
    const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
    await input.waitForExist();
    await input.click();
    await browser.keys([Key.Command, "v"]);
    await browser.waitUntil(async () => (await terminalText()).includes("printf"), {
      timeout: 20_000,
      timeoutMsg: "Command+V did not deliver clipboard text to the PTY before Enter",
    });
    await browser.keys(Key.Enter);
    await browser.waitUntil(async () => (await terminalText()).includes(marker), {
      timeout: 20_000,
      timeoutMsg: "Plain Command+V did not paste through the native app clipboard path",
    });
    await (await $('[data-testid="runtime-phase"][data-phase="exited"]')).waitForExist({
      timeout: 20_000,
    });
  } finally {
    await invokeApp("clipboard_write_text", { text: originalText });
  }
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
    timeoutMsg: "macOS E2E cleanup did not stop the PTY session",
  });
}

async function terminalText() {
  const rows = await $$('[data-testid="live-terminal"] .xterm-rows');
  const text = await rows.map((row) => row.getText());
  return text.join("\n");
}

async function invokeApp(command, args = {}) {
  return browser.execute(
    async (tauriCommand, tauriArgs) => window.__TAURI_INTERNALS__.invoke(tauriCommand, tauriArgs),
    command,
    args,
  );
}
