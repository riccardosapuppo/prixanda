// The home for three people. Marketing reads who pays and what waits, each
// approval with what it changes; in the places of revenue and of the value of
// prepaid passes not yet earned it finds who reads them (the console does
// not even ask for them). The commercial lead reads revenue and finds the
// unearned value reserved to Finance; Finance reads revenue and the unearned
// value by market, sold, activated and expired, with its total in euros
// (§9.2). The week draws the pass waiting for Finance on its lane. A home
// left open shows an incident that comes after its first reading, without a
// reload: the home watches. The week reads every page of offers, so one live
// all week shows on its lane even past the fiftieth.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { MARKETS, overview, WEEK } from "../../stories/fixtures.ts";
import { PREPAID_VALUE } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { WatchEvery } from "../../lib/react/watch.tsx";
import { HomeScreen } from "./home.tsx";

/** An open incident: the pass is not live five minutes after its start, and its launch waits to try the publish step again. */
const LATE = {
  title: "Student Autumn Pass", run: "launch-12", state: "OPEN" as const, kind: "LATE" as const, launchId: "12",
  summary: "Student Autumn Pass (#7) is not live 5 minutes after its start at 09:00 Rome.", openedAt: "2026-10-26T08:05:00Z", closedAt: null, resolution: null,
  change: { id: "7", kind: "OFFER" as const },
};

function gatewayFor(incidents: readonly (typeof LATE)[] = []) {
  return fakeGateway({
    Home: (variables: { readsRevenue: boolean; readsUnearned: boolean }) => ({
      overview: { ...overview(variables.readsRevenue), ...(variables.readsUnearned ? PREPAID_VALUE : {}), incidentsToday: incidents },
      markets: MARKETS,
    }),
    Week: () => WEEK,
  });
}

/** A home whose first reading has no incident; the launch's alarm comes with the next ones. */
function incidentLater() {
  let readings = 0;
  return fakeGateway({
    Home: (variables: { readsRevenue: boolean; readsUnearned: boolean }) => {
      readings += 1;
      return {
        overview: { ...overview(variables.readsRevenue), ...(variables.readsUnearned ? PREPAID_VALUE : {}), incidentsToday: readings > 1 ? [LATE] : [] },
        markets: MARKETS,
      };
    },
    Week: () => WEEK,
  });
}

/** Fifty offers for next year changed last, and one live all week before them: Spring for Duo in Germany, on the second page. */
function aLiveOfferOnThePageAfter() {
  const offer = (id: string, title: string, state: "SCHEDULED" | "ACTIVE", plan: string, market: string, startsLocal: string, endsLocal: string | null) => ({
    id, title, state, currentVersion: 2,
    details: { id, current: { version: 2, content: { __typename: "OfferContent" as const, plan, periods: [{ market, startsLocal, endsLocal }] } } },
  });
  const nextYear = Array.from({ length: 50 }, (_, n) => offer(String(100 + n), `Next year's offer ${n + 1}`, "SCHEDULED", "family", "FR", "2027-03-01T09:00", null));
  const live = offer("9", "Spring for Duo, Germany", "ACTIVE", "duo", "DE", "2026-10-01T09:00", "2026-11-30T00:00");
  return fakeGateway({
    Home: (variables: { readsRevenue: boolean; readsUnearned: boolean }) => ({
      overview: { ...overview(variables.readsRevenue), ...(variables.readsUnearned ? PREPAID_VALUE : {}) },
      markets: MARKETS,
    }),
    Week: (variables: { after?: string | null }) => ({
      priceList: WEEK.priceList,
      changes: variables.after == null ? { nodes: nextYear, next: "page-2" } : { nodes: [live], next: null },
    }),
  });
}

function Home({ viewer, gateway, watchEvery }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor>; readonly watchEvery?: number }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      {watchEvery ? <WatchEvery ms={watchEvery}><HomeScreen /></WatchEvery> : <HomeScreen />}
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
    await expect(await page.findByText("Finance and the commercial lead read revenue and the standing top-ups.")).toBeInTheDocument();
    await expect(page.getByText("Finance reads the value of prepaid passes sold and not yet earned (§9.2).")).toBeInTheDocument();
    await expect(page.getAllByText("As Marketing you read what every role reads: the changes, the home and the audit log (§12.2).", { exact: false })).toHaveLength(2);
    await expect(page.getByText("You wrote v3. Someone else has to approve it.")).toBeInTheDocument();
    await expect(page.getByText("Italy, Student: from €5.79 to €2.99 for 3 months, new subscribers only; 10,000 eligible; conflicts: none.")).toBeInTheDocument();
    const asked = args.gateway.calls.find((call) => call.operation === "Home")?.variables as { readsRevenue: boolean; readsUnearned: boolean };
    await expect(asked).toEqual({ readsRevenue: false, readsUnearned: false });
    await expect(page.queryByText(/Standing top-ups this month/)).toBeNull();
  },
};

export const TheCommercialLeadReadsRevenueNotUnearnedValue: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: /€20,097\.14\s*Revenue this month, without VAT/ })).toBeInTheDocument();
    await expect(page.getByText("Finance reads the value of prepaid passes sold and not yet earned (§9.2).")).toBeInTheDocument();
    const asked = args.gateway.calls.find((call) => call.operation === "Home")?.variables as { readsRevenue: boolean; readsUnearned: boolean };
    await expect(asked).toEqual({ readsRevenue: true, readsUnearned: false });
  },
};

export const FinanceReadsRevenueAndTheUnearnedValue: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: /€20,097\.14\s*Revenue this month, without VAT/ })).toBeInTheDocument();
    await expect(page.getByRole("heading", { name: /€23,639\.32\s*Prepaid passes sold, not yet earned/ })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "Italy 1,240 860 0 €23,435.80" })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: "United Kingdom 12 5 1 £170.40 €203.52" })).toBeInTheDocument();
    await expect(page.getByText(/the last part taking the remainder; an unused code stays unearned until it expires \(§9\.2\)/)).toBeInTheDocument();
    await expect(page.queryByText(/reads the value of prepaid passes/)).toBeNull();
    await expect(page.getByText("As Finance you can sign v3: review it first.")).toBeInTheDocument();
    const asked = args.gateway.calls.find((call) => call.operation === "Home")?.variables as { readsRevenue: boolean; readsUnearned: boolean };
    await expect(asked).toEqual({ readsRevenue: true, readsUnearned: true });
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

export const ALaunchThatDoesNotStartIsAnAlarm: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor([LATE]) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const alarm = await page.findByRole("alert");
    await expect(alarm).toHaveTextContent("Not live 5 minutes after its start: Student Autumn Pass.");
    await expect(within(alarm).getByRole("link", { name: /Open its launch/ })).toHaveAttribute("href", "/launches/run/?id=12");
    await expect(page.getByRole("link", { name: /See what happened/ })).toHaveAttribute("href", "/launches/run/?id=12");
  },
};

export const AnIncidentThatComesLaterShowsWithoutAReload: Story = {
  // The gateway's pace is half a minute; the story's, a moment.
  args: { viewer: PEOPLE["onCall"]!, gateway: incidentLater(), watchEvery: 300 },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/^No incidents today\./)).toBeInTheDocument();
    // The launch did not start after the first reading: the home that stayed open says so on its own.
    const alarm = await page.findByRole("alert", {}, { timeout: 5_000 });
    await expect(alarm).toHaveTextContent("Not live 5 minutes after its start: Student Autumn Pass.");
    await expect(page.queryByText(/^No incidents today\./)).toBeNull();
  },
};

export const ALiveOfferPastTheFiftiethIsOnItsLane: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: aLiveOfferOnThePageAfter() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    // Its lane is not free: the offer comes on the second page, and the week reads it.
    await expect((await page.findAllByText("Spring for Duo, Germany v2, live")).length).toBeGreaterThan(0);
    await expect(page.queryByText(/^Nothing moves this week/)).toBeNull();
    await expect(args.gateway.calls.filter((call) => call.operation === "Week")).toHaveLength(2);
  },
};
