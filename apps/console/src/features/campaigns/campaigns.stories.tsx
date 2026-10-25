// The campaigns, newest change first, twenty-five at a time. When a change
// moves (the person's action, or in the sandbox the worker's word), the list
// is read again page by page from the first, so the change at the edge of two
// pages stays on the list.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ChangesQuery } from "../../graphql/generated.ts";
import { useRefreshChanges } from "../../lib/react/gateway.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { MARKETS } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import { CampaignsScreen } from "./list.tsx";

type Row = ChangesQuery["changes"]["nodes"][number];

/** A draft campaign; the higher its number, the later its last change. */
function draft(n: number): Row {
  return {
    id: String(n), kind: "OFFER", title: `Spring offer ${n}`, state: "DRAFT", currentVersion: 1, markets: ["IT"],
    updatedAt: new Date(Date.UTC(2026, 9, 24, 8, 0) + n * 60_000).toISOString(),
    createdBy: { id: "marketing-1", label: "Marketing" },
    requiredSignatures: [],
  };
}

/** Fifty campaigns, read with the engine's keyset cursor (the last change read); create() adds a fifty-first at the top. */
function fiftyAndOneMore() {
  let changes = Array.from({ length: 50 }, (_, index) => draft(50 - index));
  const gateway = fakeGateway({
    Changes: (variables: { first: number; after: string | null }) => {
      const rest = variables.after === null ? changes : changes.filter((change) => Number(change.id) < Number(variables.after));
      const nodes = rest.slice(0, variables.first);
      return { changes: { nodes, next: rest.length > variables.first ? nodes.at(-1)?.id ?? null : null } };
    },
    Markets: () => ({ markets: MARKETS }),
  });
  return Object.assign(gateway, {
    create: () => {
      changes = [draft(51), ...changes];
    },
  });
}

/** What follows a change that moved, in the console after an action and in the sandbox when the worker says so: the changes are read again. */
function ReadAgain() {
  const refresh = useRefreshChanges();
  return <button type="button" onClick={() => void refresh()}>Read the changes again</button>;
}

function Campaigns({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof fiftyAndOneMore> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <CampaignsScreen />
      <ReadAgain />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Campaigns",
  component: Campaigns,
  parameters: { route: { pathname: "/campaigns/", query: {} } },
} satisfies Meta<typeof Campaigns>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AChangeAtThePagesEdgeStaysWhenOneIsCreated: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: fiftyAndOneMore() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("link", { name: "Spring offer 50 v1" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show 25 more" }));
    await expect(await page.findByRole("link", { name: "Spring offer 1 v1" })).toBeInTheDocument();
    // A fifty-first is created, and the list is read again: the first page ends one change sooner, and the second
    // starts where it ends now, with Spring offer 26 on it.
    args.gateway.create();
    await userEvent.click(page.getByRole("button", { name: "Read the changes again" }));
    await expect(await page.findByRole("link", { name: "Spring offer 51 v1" })).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Spring offer 26 v1" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show 25 more" }));
    await expect(await page.findByRole("link", { name: "Spring offer 1 v1" })).toBeInTheDocument();
    await expect(page.getAllByRole("row")).toHaveLength(52);
  },
};
