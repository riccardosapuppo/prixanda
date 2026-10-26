// A table wider than its box scrolls inside it: a shadow on the edge that
// still hides columns, gone once that end of the table is in sight; a table
// that fits has none.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { TableScroll } from "./table-scroll.tsx";

function Markets({ columns }: { readonly columns: number }) {
  return (
    <div className="grid w-[20rem] gap-2 p-4">
      <h2 id="markets-table" className="font-bold">Markets</h2>
      <TableScroll labelledBy="markets-table">
        <table className="data">
          <thead>
            <tr>{Array.from({ length: columns }, (_, index) => <th key={index} scope="col">Column {index + 1}</th>)}</tr>
          </thead>
          <tbody>
            <tr>{Array.from({ length: columns }, (_, index) => <td key={index}>{(index + 1) * 100}</td>)}</tr>
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

const meta = { title: "Components/TableScroll", component: Markets } satisfies Meta<typeof Markets>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The shadow drawn on one edge of the box, or not. */
const shadow = (box: Element, edge: "::before" | "::after") => getComputedStyle(box, edge).opacity;

export const AShadowWhileColumnsAreHidden: Story = {
  args: { columns: 8 },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", { name: "Markets" });
    const box = region.parentElement as HTMLElement;
    // At the start: the columns past the right edge are hidden, and the shadow is there to say so.
    await waitFor(() => expect(shadow(box, "::after")).toBe("1"));
    await expect(shadow(box, "::before")).toBe("0");
    // At the end: the last column in sight, the shadow moves to the edge the first ones went past.
    region.scrollLeft = region.scrollWidth;
    await waitFor(() => expect(shadow(box, "::after")).toBe("0"));
    await expect(shadow(box, "::before")).toBe("1");
  },
};

export const NoShadowWhenTheTableFits: Story = {
  args: { columns: 2 },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", { name: "Markets" });
    const box = region.parentElement as HTMLElement;
    await waitFor(() => expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth));
    await expect(shadow(box, "::after")).toBe("0");
    await expect(shadow(box, "::before")).toBe("0");
  },
};
