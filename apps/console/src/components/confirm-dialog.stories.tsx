// The confirmation of an irreversible action: focus on Cancel first, Cancel
// closes it and gives the focus back, the confirm button acts once. Escape is
// the browser's own and only a real key press closes a modal dialog, so the
// full stack's suite presses it (e2e/student-autumn-pass.spec.ts). It opens
// in the middle of the window, never against one of its edges.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useRef, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { Button } from "./ui.tsx";

function Harness({ onConfirm }: { readonly onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div className="p-8">
      <Button ref={opener} weight="primary" icon="signature" onClick={() => setOpen(true)}>Approve v3 as Finance</Button>
      <ConfirmDialog
        open={open}
        title="Approve v3 as Finance?"
        confirmLabel="Approve v3"
        confirmIcon="signature"
        onCancel={() => setOpen(false)}
        returnFocus={opener}
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
      >
        <p>This approval names v3 and its fingerprint.</p>
      </ConfirmDialog>
    </div>
  );
}

const meta = { title: "Components/ConfirmDialog", component: Harness, args: { onConfirm: fn() } } satisfies Meta<typeof Harness>;
export default meta;

export const CancelFirstThenConfirm: StoryObj<typeof meta> = {
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const opener = page.getByRole("button", { name: "Approve v3 as Finance" });
    await userEvent.click(opener);
    const dialog = await page.findByRole("dialog", { name: "Approve v3 as Finance?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
    await expect(opener).toHaveFocus();
    await expect(args.onConfirm).not.toHaveBeenCalled();
    await userEvent.click(opener);
    await userEvent.click(within(await page.findByRole("dialog")).getByRole("button", { name: "Approve v3" }));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
  },
};

export const InTheMiddleOfTheWindow: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const view = canvasElement.ownerDocument.defaultView ?? window;
    await userEvent.click(page.getByRole("button", { name: "Approve v3 as Finance" }));
    const dialog = await page.findByRole("dialog", { name: "Approve v3 as Finance?" });
    // As much room on the left as on the right, above as below, and some on every side.
    await waitFor(() => {
      const box = dialog.getBoundingClientRect();
      const left = box.left;
      const right = view.innerWidth - box.right;
      const top = box.top;
      const bottom = view.innerHeight - box.bottom;
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
      expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);
      expect(Math.min(left, right, top, bottom)).toBeGreaterThanOrEqual(16);
    });
  },
};
