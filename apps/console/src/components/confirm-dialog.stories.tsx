// The confirmation of an irreversible action: focus on Cancel first, Cancel
// closes it and gives the focus back, the confirm button acts once. Escape is
// the browser's own and only a real key press closes a modal dialog, so the
// full stack's suite presses it (e2e/student-autumn-pass.spec.ts).
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
