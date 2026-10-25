// The launches, newest first: each run with where it stands, the way to its
// timeline, and a filter by state that the engine applies. The runs are read
// twenty at a time and read again on their own; when a launch begins, the
// pages are read again in order, and the run at the edge of two pages stays.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { passLaunch } from "../../stories/launches.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { WatchEvery } from "../../lib/react/watch.tsx";
import { LaunchesScreen } from "./launches.tsx";

function gatewayFor() {
  const failed = passLaunch("failed");
  const recovered = { ...passLaunch("recovered"), id: "11", run: "launch-11", title: "Individual, first month at 7,99 €", version: 1, change: { id: "6", currentVersion: 1, state: "ACTIVE" as const } };
  return fakeGateway({
    LaunchRuns: (variables: { filter: { state: string } | null }) => ({
      launches: { nodes: [failed, recovered].filter((launch) => variables.filter === null || launch.state === variables.filter.state), next: null },
      markets: MARKETS,
    }),
    Launches: () => ({ overview: { launchesNext7Days: [] }, markets: MARKETS }),
    Changes: () => ({ changes: { nodes: [], next: null } }),
    Markets: () => ({ markets: MARKETS }),
  });
}

/**
 * Forty runs, newest first, read with the engine's keyset cursor (the last
 * run read); begin() starts a forty-first at the top. Launch 21, the last of
 * the first page until then, failed.
 */
function fortyAndOneMore() {
  const run = (n: number) => ({ ...passLaunch(n === 21 ? "failed" : "recovered"), id: String(n), run: `launch-${n}` });
  let runs = Array.from({ length: 40 }, (_, index) => run(40 - index));
  const gateway = fakeGateway({
    LaunchRuns: (variables: { first: number; after: string | null }) => {
      const rest = variables.after === null ? runs : runs.filter((each) => Number(each.id) < Number(variables.after));
      const nodes = rest.slice(0, variables.first);
      return { launches: { nodes, next: rest.length > variables.first ? nodes.at(-1)?.id ?? null : null }, markets: MARKETS };
    },
    Launches: () => ({ overview: { launchesNext7Days: [] }, markets: MARKETS }),
    Changes: () => ({ changes: { nodes: [], next: null } }),
    Markets: () => ({ markets: MARKETS }),
  });
  return Object.assign(gateway, {
    begin: () => {
      runs = [run(41), ...runs];
    },
  });
}

function Launches({ viewer, gateway, watchEvery }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> & { readonly begin?: () => void }; readonly watchEvery?: number }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      {watchEvery ? <WatchEvery ms={watchEvery}><LaunchesScreen /></WatchEvery> : <LaunchesScreen />}
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Launches",
  component: Launches,
  parameters: { route: { pathname: "/launches/", query: {} } },
} satisfies Meta<typeof Launches>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheRunsNewestFirstWithAFilter: Story = {
  args: { viewer: PEOPLE["onCall"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("link", { name: "launch-12" })).toHaveAttribute("href", "/launches/run/?id=12");
    await expect(page.getByRole("link", { name: "launch-11" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Failed" }));
    await expect(page.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(page.queryByRole("link", { name: "launch-11" })).toBeNull());
    await expect(page.getByRole("link", { name: "launch-12" })).toBeInTheDocument();
    const asked = args.gateway.calls.filter((call) => call.operation === "LaunchRuns").at(-1)?.variables as { filter: unknown };
    await expect(asked.filter).toEqual({ state: "FAILED" });
  },
};

export const ARunAtThePagesEdgeStaysWhenANewOneBegins: Story = {
  // The gateway's pace is half a minute; the story's, a moment.
  args: { viewer: PEOPLE["onCall"]!, gateway: fortyAndOneMore(), watchEvery: 300 },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("link", { name: "launch-40" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show 20 more" }));
    await expect(await page.findByRole("link", { name: "launch-1" })).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: "Show 20 more" })).toBeNull();
    // A forty-first begins. Read again, the first page ends one run sooner, and the second starts where it ends now:
    // the failed launch-21 is still on the list.
    args.gateway.begin?.();
    await expect(await page.findByRole("link", { name: "launch-41" }, { timeout: 5_000 })).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "launch-21" })).toBeInTheDocument();
    // The oldest is one page further on, a button away.
    await userEvent.click(page.getByRole("button", { name: "Show 20 more" }));
    await expect(await page.findByRole("link", { name: "launch-1" })).toBeInTheDocument();
    await expect(page.getAllByRole("row")).toHaveLength(42);
  },
};
