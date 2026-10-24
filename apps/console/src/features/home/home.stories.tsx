// The home for two people: Marketing reads who pays and what waits, and a
// box of the same size says who reads revenue (the console does not even
// ask for it); Finance reads the revenue and the place where unearned pass
// value will be. The week draws the pass waiting for Finance on its lane.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { MARKETS, overview, WEEK } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { HomeScreen } from "./home.tsx";

function gatewayFor() {
  return fakeGateway({
    Home: (variables: { readsRevenue: boolean }) => ({ overview: overview(variables.readsRevenue), markets: MARKETS }),
    Week: () => WEEK,
  });
}

function Home({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <HomeScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Home",
  component: Home,
  parameters: { route: { pathname: "/", query: {} } },
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MarketingDoesNotReadRevenue: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("Finance and the commercial lead read revenue.")).toBeInTheDocument();
    await expect(page.getByText("You wrote v3. Someone else has to approve it.")).toBeInTheDocument();
    const asked = args.gateway.calls.find((call) => call.operation === "Home")?.variables as { readsRevenue: boolean };
    await expect(asked.readsRevenue).toBe(false);
    await expect(page.queryByText(/Standing top-ups this month/)).toBeNull();
  },
};

export const FinanceReadsRevenue: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: /€20,097\.14\s*Revenue this month, without VAT/ })).toBeInTheDocument();
    await expect(page.getByText(/Prepaid passes sold and not yet earned/)).toBeInTheDocument();
    await expect(page.getByText("As Finance you can sign v3: review it first.")).toBeInTheDocument();
  },
};

export const TheWeekLinesUpByUtcOnRequest: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    // The lane's words are written twice, for the lanes and for the phone's list; one of them shows.
    await expect((await page.findAllByText(/starts Mon 26 Oct, 09:00 Rome, if it is signed in time/)).length).toBeGreaterThan(0);
    await userEvent.click(page.getByRole("button", { name: "UTC" }));
    await expect(page.getByRole("button", { name: "UTC" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Lined up by UTC, the same instant falls on the same vertical/)).toBeInTheDocument();
  },
};
