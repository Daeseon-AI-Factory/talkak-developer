import { describe, expect, it } from "vitest";
import { createConversationScrollManager } from "./conversationScroll";

function scroller(scrollTop: number, scrollHeight: number, clientHeight = 200) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("conversation scroll", () => {
  it("opens at the newest message", () => {
    const manager = createConversationScrollManager();
    const viewport = scroller(0, 1_000);

    manager.afterRender(viewport);

    expect(viewport.scrollTop).toBe(1_000);
  });

  it("follows appended messages only while the reader remains near the bottom", () => {
    const manager = createConversationScrollManager();
    const viewport = scroller(0, 1_000);
    manager.afterRender(viewport);

    viewport.scrollTop = 800;
    manager.onScroll(viewport);
    viewport.scrollHeight = 1_100;
    manager.afterRender(viewport);
    expect(viewport.scrollTop).toBe(1_100);

    viewport.scrollTop = 300;
    manager.onScroll(viewport);
    viewport.scrollHeight = 1_200;
    manager.afterRender(viewport);
    expect(viewport.scrollTop).toBe(300);
  });

  it("keeps the same message in view when older history is prepended", () => {
    const manager = createConversationScrollManager();
    const viewport = scroller(0, 1_000);
    manager.afterRender(viewport);
    viewport.scrollTop = 80;

    manager.beforeLoadOlder(viewport);
    viewport.scrollHeight = 1_400;
    manager.afterRender(viewport);

    expect(viewport.scrollTop).toBe(480);
  });
});
