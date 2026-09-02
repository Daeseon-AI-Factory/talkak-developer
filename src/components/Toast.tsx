import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A moment of feedback in the corner of a surface: "copied", "opened src/a.ts:12", or why not.
 * One element, replaced rather than stacked, never in the way of the pointer (pointer-events off)
 * and gone on its own. Both terminal surfaces — the live pane and the read-only log — show theirs
 * through this, so a copy looks the same wherever it happened.
 */

export interface ToastNotice {
  tone: "ok" | "error";
  text: string;
}

export interface ShownToast extends ToastNotice {
  /** Changes on every show, so the same text twice restarts the fade. */
  id: number;
}

export const TOAST_VISIBLE_MS = 1600;

export function useToast(visibleMs = TOAST_VISIBLE_MS): {
  toast: ShownToast | null;
  show: (notice: ToastNotice) => void;
} {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const counter = useRef(0);
  const show = useCallback((notice: ToastNotice) => {
    counter.current += 1;
    setToast({ ...notice, id: counter.current });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, visibleMs);
    return () => clearTimeout(timer);
  }, [toast, visibleMs]);
  return { toast, show };
}

export function Toast({ notice }: { notice: ShownToast | null }) {
  if (!notice) return null;
  return (
    <output key={notice.id} className="toast" data-tone={notice.tone} aria-live="polite">
      <span aria-hidden="true">{notice.tone === "error" ? "✗" : "✓"}</span>
      <span className="toast__text">{notice.text}</span>
    </output>
  );
}
