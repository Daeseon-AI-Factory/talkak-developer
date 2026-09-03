import { useEffect, useRef } from "react";
import type { DesktopPlatform } from "./platform";
import { type ShortcutCommandId, commandForShortcut } from "./shortcutRegistry";

export type ShortcutHandlers = Partial<Record<ShortcutCommandId, () => void>>;

export function useShortcutDispatcher({
  platform,
  workspaceEnabled,
  disabled = false,
  handlers,
}: {
  platform: DesktopPlatform;
  workspaceEnabled: boolean;
  disabled?: boolean;
  handlers: ShortcutHandlers;
}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const dispatch = (event: KeyboardEvent) => {
      if (disabled || event.isComposing) return;
      const definition = commandForShortcut(event, platform, workspaceEnabled);
      if (!definition) return;
      if (definition.scope === "workspace" && isOrdinaryEditor(event.target)) return;
      const handler = handlersRef.current[definition.id];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      if (!definition.repeat && event.repeat) return;
      handler();
    };
    window.addEventListener("keydown", dispatch, true);
    return () => window.removeEventListener("keydown", dispatch, true);
  }, [disabled, platform, workspaceEnabled]);
}

function isOrdinaryEditor(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}
