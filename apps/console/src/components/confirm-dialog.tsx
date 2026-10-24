"use client";
// The confirmation of an action that cannot be undone: a modal dialog (the
// browser's own, so focus stays inside and Escape closes it), with the focus
// on Cancel first, and back on the button that opened it when it closes. It
// opens from the centre in 220 ms; from the keyboard, or with reduced
// motion, it does not move.
import type { IconName } from "design";
import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { Button } from "./ui.tsx";

export function ConfirmDialog({ open, title, children, confirmLabel, confirmIcon, busy = false, onCancel, onConfirm, returnFocus }: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly confirmIcon: IconName;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void | Promise<void>;
  readonly returnFocus?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
      const back = returnFocus?.current ?? (opener.current instanceof HTMLElement ? opener.current : null);
      back?.focus();
    }
  }, [open, returnFocus]);

  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form method="dialog" className="grid gap-4 p-6" onSubmit={(event) => event.preventDefault()}>
        <h2 id={titleId} className="text-3xl font-bold">{title}</h2>
        <div className="grid gap-3">{children}</div>
        <div className="flex flex-wrap gap-3">
          <Button autoFocus onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button weight="primary" icon={confirmIcon} busy={busy} onClick={() => void onConfirm()}>{confirmLabel}</Button>
        </div>
      </form>
    </dialog>
  );
}
