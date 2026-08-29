import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/**
 * Resizing a pane — dragging a split, snapping the window to half the screen — makes xterm reflow
 * its lines, and reflow drops the viewport to the bottom. Unthrottled, a ResizeObserver fires that
 * many times per drag, so scrollback appeared to race past on every resize.
 *
 * Two rules fix it: coalesce fits to one per animation frame, and put the viewport back where the
 * reader left it. Someone already at the bottom stays at the bottom — that is where new output
 * belongs.
 */

/**
 * The line to scroll back to after a reflow, or null to leave the viewport alone.
 *
 * `baseY` is the top line of the scrollback's live region and `viewportY` the top line on screen,
 * so `baseY - viewportY` is how far the reader had scrolled UP. Reflow changes `baseY` (lines
 * rewrap), so the distance from the bottom is what survives a resize, not the absolute line.
 */
export function preservedScrollLine(
  beforeBaseY: number,
  beforeViewportY: number,
  afterBaseY: number,
): number | null {
  const scrolledUpBy = beforeBaseY - beforeViewportY;
  if (scrolledUpBy <= 0) return null;
  const line = afterBaseY - scrolledUpBy;
  // The old position no longer exists — the buffer shrank past it. Leave the viewport where the
  // reflow put it: clamping to 0 here yanked the pane to the very top of its scrollback, which is
  // the last place the reader was looking.
  if (line <= 0) return null;
  return line;
}

export interface TerminalFitter {
  /** Request a fit; repeated calls within one frame collapse into a single reflow. */
  schedule: () => void;
  dispose: () => void;
}

export function createTerminalFitter(
  terminal: Terminal,
  fitAddon: FitAddon,
  host: () => HTMLElement | null,
  onError?: (cause: unknown) => void,
  onSuccess?: () => void,
): TerminalFitter {
  let frame: number | undefined;

  const fit = () => {
    frame = undefined;
    const element = host();
    if (!element || element.clientWidth === 0 || element.clientHeight === 0) return;
    const before = terminal.buffer.active;
    const beforeBaseY = before.baseY;
    const beforeViewportY = before.viewportY;
    const beforeCols = terminal.cols;
    const beforeRows = terminal.rows;
    try {
      fitAddon.fit();
      // Only an actual dimension change reflows the buffer. Without this guard every observer
      // tick — including the ones a pane fires while output is arriving — moved the viewport,
      // which is how a finished burst of output could end up scrolled somewhere nobody asked for.
      if (terminal.cols !== beforeCols || terminal.rows !== beforeRows) {
        // Deferred by a frame. xterm 6 scrolls through a new viewport that re-bases its scroll
        // dimensions asynchronously after a resize, so a scrollToLine issued here was measured
        // against the OLD geometry and landed somewhere else — usually the bottom. That is the
        // resize putting the reader somewhere they did not ask to be.
        requestAnimationFrame(() => {
          // xterm 6's reflow already holds a scrolled-up reader's absolute line. Correcting again
          // on top of that moved them twice; only act when the reflow did not preserve it.
          if (terminal.buffer.active.viewportY === beforeViewportY) return;
          const line = preservedScrollLine(
            beforeBaseY,
            beforeViewportY,
            terminal.buffer.active.baseY,
          );
          if (line !== null) terminal.scrollToLine(line);
        });
      }
      onSuccess?.();
    } catch (cause: unknown) {
      onError?.(cause);
    }
  };

  return {
    schedule: () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(fit);
    },
    dispose: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}
