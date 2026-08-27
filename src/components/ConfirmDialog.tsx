import { useEffect } from "react";

export interface ConfirmAction {
  label: string;
  detail?: string;
  tone?: "danger" | "primary" | "neutral";
  onSelect: () => void;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  actions: ConfirmAction[];
  cancelLabel: string;
  onCancel: () => void;
}

/**
 * One confirmation surface for destructive choices — stopping a session, quitting with work
 * running. Escape and a backdrop click are always the safe path (cancel), never the destructive
 * one.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  actions,
  cancelLabel,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <dialog open aria-modal="true" className="confirm-dialog">
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="confirm-dialog__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              data-tone={action.tone ?? "neutral"}
              onClick={action.onSelect}
            >
              <strong>{action.label}</strong>
              {action.detail ? <small>{action.detail}</small> : null}
            </button>
          ))}
          <button type="button" data-tone="cancel" onClick={onCancel}>
            <strong>{cancelLabel}</strong>
          </button>
        </div>
      </dialog>
    </div>
  );
}
