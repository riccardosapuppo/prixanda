// A price migration's simulation and its progress. At the business book's
// acceptance, 90% and said to be illustrative, the German Family rise loses
// €703.08 of revenue a month: below the break-even of 90.48%. Typed as 93%,
// the same rise brings €3,742.20, with €9,400.44 a month at risk; the
// numbers per subscription are §8.7's. Once the requests went out, the
// progress says how many were asked, and who waits, accepted or declined;
// before, when they go out. Without the markets it shows no time: Berlin's
// 09:00 read as UTC would be an hour off.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { familySimulation, germanFamily, MID_WINDOW, POLICIES } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import { GatewayError } from "../../lib/gateway.ts";
import type { Viewer } from "../../lib/react/session.tsx";
import { MigrationProgressScreen } from "./progress.tsx";
import { MigrationSimulationScreen } from "./simulation.tsx";

function gatewayFor(change = germanFamily("IN_APPROVAL")) {
  return fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    PriceChangePolicies: () => POLICIES,
    Change: () => ({ change }),
    SimulateMigration: (variables: { overrides: { name: string; value: number }[] | null }) => ({
      simulateMigration: familySimulation(variables.overrides?.some((entry) => entry.name === "ACCEPTANCE" && entry.value === 9300) ? 9300 : 9000),
    }),
    LaunchRuns: () => ({ launches: { nodes: [], next: null } }),
  });
}

/** A scheduled migration whose markets fail to load the first time, and load when the person tries again. */
function marketsFailOnce(change = germanFamily("SCHEDULED", { signed: true })) {
  let asked = 0;
  return fakeGateway({
    Markets: () => {
      asked += 1;
      if (asked === 1) throw new GatewayError("UNREACHABLE", "The gateway did not answer.", "console:markets-1");
      return { markets: MARKETS };
    },
    Change: () => ({ change }),
    PriceChangePolicies: () => POLICIES,
    LaunchRuns: () => ({ launches: { nodes: [], next: null } }),
  });
}

function Screen({ viewer, gateway, view }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor>; readonly view: "simulation" | "progress" }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      {view === "simulation" ? <MigrationSimulationScreen /> : <MigrationProgressScreen />}
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Price migration, simulation and progress",
  component: Screen,
  parameters: { route: { pathname: "/price-migrations/simulation/", query: { id: "21" } } },
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AtTheBooksAcceptanceItLosesRevenue: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor(), view: "simulation" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "If 90% accept, revenue falls by €703.08 a month in Germany." })).toBeInTheDocument();
    await expect(page.getByText("Revenue holds if at least 90.48% accept; the contribution holds from 90.42%.")).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "Price, VAT included €18.99 €20.99 +€2.00" })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "Net of VAT €15.96 €17.64 +€1.68" })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "Owed to artists €9.58 €10.58 +€1.00" })).toBeInTheDocument();
    await expect(page.getByText("Default: business book §16 (illustrative)")).toBeInTheDocument();
    await expect(page.getByRole("textbox", { name: /^Acceptance/ })).toHaveValue("90");
    await expect(page.getByText(/841 would move to the Free plan, by the music service's choice/)).toBeInTheDocument();
    // Who signs: conditions 1 and 5 are met.
    const signs = within(page.getByRole("region", { name: "Who has to sign" }));
    await expect(signs.getByText(/condition/)).toHaveTextContent("conditions 1 and 5");
  },
};

export const TypingAnAcceptanceMovesTheRevenueAtRisk: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(), view: "simulation" },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const field = await page.findByRole("textbox", { name: /^Acceptance/ });
    await userEvent.clear(field);
    await userEvent.type(field, "93{Enter}");
    await expect(await page.findByRole("heading", { name: "If 93% accept, revenue rises by €3,742.20 a month in Germany." })).toBeInTheDocument();
    await expect(page.getByText("€9,400.44")).toBeInTheDocument();
    await expect(page.getByText(/^Typed by the commercial lead at/)).toBeInTheDocument();
    await waitFor(() => {
      const last = args.gateway.calls.filter((call) => call.operation === "SimulateMigration").at(-1);
      expect(last?.variables).toEqual({ changeId: "21", version: 1, overrides: [{ name: "ACCEPTANCE", value: 9300 }] });
    });
    await userEvent.click(page.getByRole("button", { name: "Reset" }));
    await expect(await page.findByRole("heading", { name: "If 90% accept, revenue falls by €703.08 a month in Germany." })).toBeInTheDocument();
  },
};

export const ThePeopleInTheMiddleOfTheWindow: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(germanFamily("ACTIVE", { signed: true, progress: MID_WINDOW })), view: "progress" },
  parameters: { route: { pathname: "/price-migrations/progress/", query: { id: "21" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "8,412 Family subscribers in Germany asked for their consent; 3,120 have not answered yet." })).toBeInTheDocument();
    await expect(page.getByText(/The window ends Thu 17 Dec 2026, 23:59 Berlin \(22:59 UTC\)\. Silence counts as no\./)).toBeInTheDocument();
    await expect(page.getByRole("img", { name: "Of 8,412: 4,987 accepted, 3,120 waiting, 305 declined, 0 lapsed." })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: /^Accepted Said yes: they pay the new price from their first charge after it\. 4,987$/ })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: /^Lapsed No answer by the end of the window: silence is no .* 0$/ })).toBeInTheDocument();
    await expect(page.getByText(/^Nobody has left the paid plan over it yet/)).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "Asked 8,412" })).toBeInTheDocument();
    // The rules of the market beside the counts, the law apart from the choice.
    await expect(await page.findByRole("region", { name: "What the law asks" })).toBeInTheDocument();
  },
};

export const BeforeTheRequestsGoOut: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(germanFamily("SCHEDULED", { signed: true })), view: "progress" },
  parameters: { route: { pathname: "/price-migrations/progress/", query: { id: "21" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Scheduled: the requests go out Mon 02 Nov 2026, 09:00 Berlin \(08:00 UTC\)\./)).toBeInTheDocument();
    await expect(page.queryByRole("img", { name: /^Of / })).toBeNull();
  },
};

export const WithoutTheMarketsTheProgressShowsNoTime: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: marketsFailOnce(), view: "progress" },
  parameters: { route: { pathname: "/price-migrations/progress/", query: { id: "21" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/^The markets did not load, and with them their time zones/)).toBeInTheDocument();
    await expect(page.queryByText(/UTC\)/)).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    // With the markets, Berlin's 09:00 is 08:00 UTC that day.
    await expect(await page.findByText(/Scheduled: the requests go out Mon 02 Nov 2026, 09:00 Berlin \(08:00 UTC\)\./)).toBeInTheDocument();
  },
};
