// The approvals' queues are read fifty at a time. With 51 changes waiting for
// a signature, the count says more than 50 while the engine has more, and the
// next page brings the oldest one in: no change of a queue is left out.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ChangesQuery } from "../../graphql/generated.ts";
import { MARKETS } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { ApprovalsScreen } from "./list.tsx";

type Row = ChangesQuery["changes"]["nodes"][number];

/** A change in a queue, newest first: number 1 is the newest. */
function row(n: number, state: Row["state"]): Row {
  return {
    id: String(n), kind: "OFFER", title: `Spring offer ${n}`, state, currentVersion: 1, markets: ["IT"],
    updatedAt: new Date(Date.UTC(2026, 9, 24, 8, 0) - n * 60_000).toISOString(),
    createdBy: { id: "marketing-1", label: "Marketing" },
    requiredSignatures: [{ role: "FINANCE", conditions: [2], why: "Finance must sign: condition 2 of §7.3.", signed: false }],
  };
}

const WAITING = Array.from({ length: 51 }, (_, index) => row(index + 1, "IN_APPROVAL"));
const APPROVED = [row(101, "APPROVED"), row(102, "SCHEDULED")];

function gatewayFor() {
  return fakeGateway({
    Changes: (variables: { filter: { states: string[] }; first: number; after: string | null }) => {
      const all = variables.filter.states.includes("IN_APPROVAL") ? WAITING : APPROVED;
      const start = variables.after === null ? 0 : Number(variables.after);
      const end = start + variables.first;
      return { changes: { nodes: all.slice(start, end), next: end < all.length ? String(end) : null } };
    },
    Markets: () => ({ markets: MARKETS }),
  });
}

function Approvals({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <ApprovalsScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Approvals",
  component: Approvals,
  parameters: { route: { pathname: "/approvals/", query: {} } },
} satisfies Meta<typeof Approvals>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FiftyOneWaitingAreAllThere: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "More than 50 Waiting for a signature" })).toBeInTheDocument();
    await expect(page.getByText("The first 50 are shown, and there are more.")).toBeInTheDocument();
    await expect(page.queryByText("Spring offer 51")).toBeNull();
    // The other queue has all it holds: its count is exact, and nothing more to show.
    await expect(page.getByRole("heading", { name: "2 Approved, not live yet" })).toBeInTheDocument();
    await expect(page.getAllByRole("button", { name: "Show the next 50" })).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Show the next 50" }));
    await expect(await page.findByText("Spring offer 51")).toBeInTheDocument();
    await expect(page.getByRole("heading", { name: "51 Waiting for a signature" })).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: "Show the next 50" })).toBeNull();
    await waitFor(() => {
      const asked = args.gateway.calls.filter((call) => call.operation === "Changes" && (call.variables as { filter: { states: string[] } }).filter.states.includes("IN_APPROVAL"));
      expect(asked.map((call) => (call.variables as { after: string | null }).after)).toEqual([null, "50"]);
    });
  },
};
