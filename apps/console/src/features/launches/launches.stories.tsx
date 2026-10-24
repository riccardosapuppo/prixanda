// The launches, newest first: each run with where it stands, the way to its
// timeline, and a filter by state that the engine applies.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { passLaunch } from "../../stories/launches.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
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

function Launches({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <LaunchesScreen />
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
