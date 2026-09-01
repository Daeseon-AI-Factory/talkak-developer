import { strict as assert } from "node:assert";
import { Key } from "webdriverio";

const copiedLines = ["talkakcopylineone", "talkakcopylinetwo", "talkakcopylinethree"];

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
      await browser.waitUntil(
        async () => (await terminalDragSnapshot(drag)).selectionRects.length > 0,
        {
          timeout: 2_000,
          interval: 50,
          timeoutMsg: "The pointer drag did not create an xterm selection",
        },
      );
    } catch (error) {
      selectionWaitError = String(error);
    }

    const selectionSnapshot = await terminalDragSnapshot(drag);
    assert.ok(
      selectionSnapshot.selectionRects.length > 0,
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

async function waitForVisibleTerminalLines() {
  await browser.waitUntil(
    async () => {
      const visible = await browser.execute(() =>
        [...document.querySelectorAll('[data-testid="live-terminal"] .xterm-rows > div')].map(
          (row) => row.textContent?.trimEnd() ?? "",
        ),
      );
      return copiedLines.every((line) => visible.includes(line));
    },
    { timeout: 20_000, timeoutMsg: "The PTY did not render the multiline copy probe" },
  );
}

async function dragAcrossVisibleTerminalLines() {
  const drag = await browser.execute((expectedLines) => {
    const terminal = document.querySelector('[data-testid="live-terminal"]');
    const screen = terminal?.querySelector(".xterm-screen");
    const measure = terminal?.querySelector(".xterm-char-measure-element");
    const rows = [...(terminal?.querySelectorAll(".xterm-rows > div") ?? [])];
    const indexes = expectedLines.map((line) =>
      rows.findIndex((row) => row.textContent?.trimEnd() === line),
    );
    if (!screen || !measure || indexes.some((index) => index < 0)) return null;
    if (indexes.some((index, offset) => offset > 0 && index !== indexes[0] + offset)) return null;

    const measureTextLength = measure.textContent?.length ?? 0;
    const cellWidth = measure.getBoundingClientRect().width / measureTextLength;
    const screenRect = screen.getBoundingClientRect();
    const screenStyle = getComputedStyle(screen);
    const paddingLeft = Number.parseFloat(screenStyle.paddingLeft) || 0;
    const firstRect = rows[indexes[0]].getBoundingClientRect();
    const lastRect = rows[indexes.at(-1)].getBoundingClientRect();
    if (!(cellWidth > 0) || !(firstRect.height > 0) || !(lastRect.height > 0)) return null;

    const startX = screenRect.left + paddingLeft + cellWidth * 0.25;
    const startY = firstRect.top + firstRect.height / 2;
    const endX = screenRect.left + paddingLeft + cellWidth * expectedLines.at(-1).length;
    const endY = lastRect.top + lastRect.height / 2;
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
      cellWidth,
      rowIndexes: indexes,
      screenRect: {
        left: screenRect.left,
        top: screenRect.top,
        width: screenRect.width,
        height: screenRect.height,
      },
      firstRect: {
        left: firstRect.left,
        top: firstRect.top,
        width: firstRect.width,
        height: firstRect.height,
      },
      lastRect: {
        left: lastRect.left,
        top: lastRect.top,
        width: lastRect.width,
        height: lastRect.height,
      },
      startElement: describeElement(document.elementFromPoint(startX, startY)),
      endElement: describeElement(document.elementFromPoint(endX, endY)),
    };
  }, copiedLines);
  assert.ok(drag, "Could not locate three consecutive rendered terminal rows for dragging");

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
    const terminal = document.querySelector('[data-testid="live-terminal"]');
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
      selectionRects: [...(terminal?.querySelectorAll(".xterm-selection > div") ?? [])].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        },
      ),
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
