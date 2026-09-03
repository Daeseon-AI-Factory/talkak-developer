import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface ConversationScroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

const BOTTOM_TOLERANCE_PX = 32;

export interface ConversationScrollManager {
  afterRender: (scroller: ConversationScroller) => void;
  beforeLoadOlder: (scroller: ConversationScroller) => void;
  onScroll: (scroller: ConversationScroller) => void;
}

/** Keeps chat-like follow behavior without pulling a reader away from older messages. */
export function createConversationScrollManager(): ConversationScrollManager {
  let positioned = false;
  let followNewest = true;
  let olderSnapshot: { scrollHeight: number; scrollTop: number } | null = null;

  return {
    afterRender(scroller) {
      if (olderSnapshot) {
        const addedHeight = scroller.scrollHeight - olderSnapshot.scrollHeight;
        scroller.scrollTop = olderSnapshot.scrollTop + Math.max(0, addedHeight);
        olderSnapshot = null;
        positioned = true;
        followNewest = false;
        return;
      }

      if (!positioned || followNewest) scroller.scrollTop = scroller.scrollHeight;
      positioned = true;
    },
    beforeLoadOlder(scroller) {
      olderSnapshot = {
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      };
      followNewest = false;
    },
    onScroll(scroller) {
      const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      followNewest = distanceFromBottom <= BOTTOM_TOLERANCE_PX;
    },
  };
}

export function useConversationScroll(scrollerRef: RefObject<HTMLElement | null>): () => void {
  const managerRef = useRef<ConversationScrollManager | null>(null);
  if (!managerRef.current) managerRef.current = createConversationScrollManager();
  const manager = managerRef.current;

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) manager.afterRender(scroller);
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Mobile owns the scroller in the parent component, whose ref can attach after this child's
    // layout effect. Position once here as well; the manager makes the desktop repeat idempotent.
    manager.afterRender(scroller);
    const onScroll = () => manager.onScroll(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    manager.onScroll(scroller);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [manager, scrollerRef]);

  return useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) manager.beforeLoadOlder(scroller);
  }, [manager, scrollerRef]);
}
