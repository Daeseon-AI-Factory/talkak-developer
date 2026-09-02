import { strict as assert } from "node:assert";
import { Key } from "webdriverio";

const copiedLines = ["talkakcopylineone", "talkakcopylinetwo", "talkakcopylinethree"];

/**
 * Pastes a command that prints three known lines, drags the pointer across them, and checks the
 * auto-copy put exactly those lines on the native clipboard.
 *
 * Reads the emulator through the CI test hooks (`window.__talkakTest`), never through `.xterm-rows`:
 * those elements are the DOM renderer's private layout, one WebDriver round-trip per row to read,
 * and gone the day the renderer changes. Row positions come from the terminal's cell geometry; the
 * selection from xterm itself.
 */
export async function verifyMultilineDragAutoCopy({
  command,
  pasteChord,
  lineEnding,
  skipImageClipboard = false,
}) {
  const imagePath = await invokeApp("clipboard_read_image_path");
  if (imagePath !== null && skipImageClipboard) return;
  assert.equal(
    imagePath,
    null,
    "Refusing to replace an image clipboard that cannot be restored as text",
  );

  const originalText = await invokeApp("clipboard_read_text");
  const sentinel = "talkak-copy-not-yet-replaced";

  try {
    await invokeApp("clipboard_write_text", { text: command });
    const input = await $('[data-testid="live-terminal"] .xterm-helper-textarea');
    await input.waitForExist();
    await input.click();
    await browser.keys(pasteChord);
    await browser.keys(Key.Enter);
    await waitForVisibleTerminalLines();

    await invokeApp("clipboard_write_text", { text: sentinel });
    const drag = await dragAcrossVisibleTerminalLines();
    let selectionWaitError = null;
    try {
      await browser.waitUntil(async () => (await terminalDragSnapshot(drag)).selection.length > 0, {
        timeout: 2_000,
        interval: 50,
        timeoutMsg: "The pointer drag did not create an xterm selection",
      });
    } catch (error) {
      selectionWaitError = String(error);
    }

    const selectionSnapshot = await terminalDragSnapshot(drag);
    assert.ok(
      selectionSnapshot.selection.length > 0,
      `The WebDriver pointer drag never reached xterm selection: ${JSON.stringify({
        drag,
        selectionSnapshot,
        selectionWaitError,
      })}`,
    );

    const expectedClipboard = copiedLines.join(lineEnding);
    let clipboardWaitError = null;
    try {
      await browser.waitUntil(
        async () => (await invokeApp("clipboard_read_text")) === expectedClipboard,
        { timeout: 5_000, interval: 50 },
      );
    } catch (error) {
      clipboardWaitError = String(error);
    }
    const clipboardText = await invokeApp("clipboard_read_text");
    assert.equal(
      clipboardText,
      expectedClipboard,
      `xterm selected text but auto-copy did not produce the exact native text: ${JSON.stringify({
        drag,
        selectionSnapshot: await terminalDragSnapshot(drag),
        clipboardWaitError,
      })}`,
    );
  } finally {
    await invokeApp("clipboard_write_text", { text: originalText });
  }
}

async function terminalLines() {
  return browser.execute(() => window.__talkakTest?.liveTerminalLines() ?? []);
}

async function waitForVisibleTerminalLines() {
  await browser.waitUntil(
    async () => {
      const visible = (await terminalLines()).map((line) => line.trimEnd());
      return copiedLines.every((line) => visible.includes(line));
    },
    { timeout: 20_000, timeoutMsg: "The PTY did not render the multiline copy probe" },
  );
}

async function dragAcrossVisibleTerminalLines() {
  const drag = await browser.execute((expectedLines) => {
    const hooks = window.__talkakTest;
    const geometry = hooks?.liveTerminalGeometry();
    const lines = hooks?.liveTerminalLines() ?? [];
    if (!geometry) return null;
    const indexes = expectedLines.map((line) =>
      lines.findIndex((candidate) => candidate.trimEnd() === line),
    );
    if (indexes.some((index) => index < 0)) return null;
    if (indexes.some((index, offset) => offset > 0 && index !== indexes[0] + offset)) return null;
    // Absolute buffer lines → viewport rows; all three must be on screen to be dragged across.
    const viewportRows = indexes.map((index) => index - geometry.viewportY);
    if (viewportRows.some((row) => row < 0 || row >= geometry.rows)) return null;
    const { cellWidth, cellHeight, screenLeft, screenTop } = geometry;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return null;

    const screen = document.querySelector('[data-testid="live-terminal"] .xterm-screen');
    const screenRect = screen?.getBoundingClientRect();
    if (!screenRect) return null;
    const startX = screenLeft + cellWidth * 0.25;
    const startY = screenTop + cellHeight * (viewportRows[0] + 0.5);
    const endX = screenLeft + cellWidth * expectedLines.at(-1).length;
    const endY = screenTop + cellHeight * (viewportRows.at(-1) + 0.5);
    const describeElement = (element) =>
      element
        ? {
            tag: element.tagName,
            className: typeof element.className === "string" ? element.className : "",
            testId: element.getAttribute("data-testid"),
          }
        : null;

    return {
      startOffsetX: Math.round(startX - (screenRect.left + screenRect.width / 2)),
      startOffsetY: Math.round(startY - (screenRect.top + screenRect.height / 2)),
      endOffsetX: Math.round(endX - (screenRect.left + screenRect.width / 2)),
      endOffsetY: Math.round(endY - (screenRect.top + screenRect.height / 2)),
      absolutePoints: {
        startX: Math.round(startX),
        startY: Math.round(startY),
        endX: Math.round(endX),
        endY: Math.round(endY),
      },
      geometry,
      rowIndexes: indexes,
      viewportRows,
      startElement: describeElement(document.elementFromPoint(startX, startY)),
      endElement: describeElement(document.elementFromPoint(endX, endY)),
    };
  }, copiedLines);
  assert.ok(drag, "Could not locate three consecutive on-screen terminal lines for dragging");

  await browser.execute(() => {
    window.__talkakPointerProbe = [];
    for (const eventName of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mousemove",
      "mouseup",
    ]) {
      document.addEventListener(
        eventName,
        (event) => {
          if (window.__talkakPointerProbe.length >= 40) return;
          window.__talkakPointerProbe.push({
            type: event.type,
            x: Math.round(event.clientX),
            y: Math.round(event.clientY),
            button: event.button,
            buttons: event.buttons,
            detail: event.detail,
            target:
              event.target instanceof Element
                ? `${event.target.tagName}.${event.target.className}`
                : "unknown",
          });
        },
        { capture: true, once: eventName === "pointerdown" || eventName === "mousedown" },
      );
    }
  });

  const screen = await $('[data-testid="live-terminal"] .xterm-screen');
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 0, origin: screen, x: drag.startOffsetX, y: drag.startOffsetY })
    .down({ button: "left" })
    .move({ duration: 200, origin: screen, x: drag.endOffsetX, y: drag.endOffsetY })
    .up({ button: "left" })
    .perform();
  return drag;
}

async function terminalDragSnapshot(drag) {
  return browser.execute((absolutePoints) => {
    const describeElement = (element) =>
      element
        ? {
            tag: element.tagName,
            className: typeof element.className === "string" ? element.className : "",
            testId: element.getAttribute("data-testid"),
          }
        : null;
    return {
      events: window.__talkakPointerProbe ?? [],
      selection: window.__talkakTest?.liveTerminalSelection() ?? "",
      startElement: describeElement(
        document.elementFromPoint(absolutePoints.startX, absolutePoints.startY),
      ),
      endElement: describeElement(
        document.elementFromPoint(absolutePoints.endX, absolutePoints.endY),
      ),
      activeElement: describeElement(document.activeElement),
    };
  }, drag.absolutePoints);
}

async function invokeApp(command, args = {}) {
  return browser.execute(
    async (tauriCommand, tauriArgs) => window.__TAURI_INTERNALS__.invoke(tauriCommand, tauriArgs),
    command,
    args,
  );
}
