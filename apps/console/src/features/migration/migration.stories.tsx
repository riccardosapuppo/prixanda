// The guided writing of a price migration for three moments. The commercial
// lead starts from the business book's example (§14.3): the German Family
// rise, and beside the form the rules of Germany in two blocks that never mix
// (§8.1), the law with its sources and the music service's choice with its
// label. The check names what the engine blocks (price, dates, overlap) and
// sends the author back to the step that fixes each. A checked version is
// submitted with Finance to sign, conditions 1 and 5. Marketing reads it with
// the fields read-only.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { familySimulation, germanFamily, PLANS_DE, POLICIES } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { MigrationEditor } from "./form.tsx";

function gatewayFor(change = germanFamily("DRAFT")) {
  let submitted = false;
  return fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_DE }),
    PriceChangePolicies: () => POLICIES,
    Change: () => ({ change: submitted ? germanFamily("IN_APPROVAL") : change }),
    SimulateMigration: () => ({ simulateMigration: familySimulation(9000) }),
    SubmitChange: () => {
      submitted = true;
      return { submitChange: { __typename: "Change", ...germanFamily("IN_APPROVAL") } };
    },
  });
}

function Writing({ viewer, gateway, changeId }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor>; readonly changeId: string | null }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <MigrationEditor changeId={changeId} />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Price migration",
  component: Writing,
  parameters: { route: { pathname: "/price-migrations/new/", query: {} } },
} satisfies Meta<typeof Writing>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheGermanRulesBesideTheExample: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the Family price rise in Germany" }));
    await expect(page.getByLabelText("Migration name")).toHaveValue("Family price rise, Germany");
    await expect(page.getByRole("radio", { name: /^Germany/ })).toBeChecked();
    await expect(page.getByLabelText("New price in Germany, VAT included")).toHaveValue("20.99");
    await expect(await page.findByText(/€2\.00 a month more than €18\.99 \(10\.53% more\)/)).toBeInTheDocument();
    // The law and the choice: two blocks, each with its own heading, never mixed (§8.1).
    const law = page.getByRole("region", { name: "What the law asks" });
    const choice = page.getByRole("region", { name: "What Rione chose" });
    await expect(within(law).getByText("Consent: each existing subscriber has to say yes, and silence counts as no.")).toBeInTheDocument();
    await expect(within(law).getByText("Kammergericht (Berlin), two judgments of 15 November 2023, press release 27/2023")).toBeInTheDocument();
    await expect(within(law).queryByText(/configurable per market/)).toBeNull();
    await expect(within(choice).getByText("The music service's choice, configurable per market; not a legal requirement.")).toBeInTheDocument();
    await expect(within(choice).getByText("45 days to answer, counted from the request")).toBeInTheDocument();
    await expect(within(choice).queryByText(/Kammergericht/)).toBeNull();
    // Italy's rules are another market's: notice, not consent.
    await expect(page.getByRole("radio", { name: /^Italy/ })).toHaveAccessibleName(/Notice: 30 days of notice before the new price applies/);
  },
};

export const TheCheckNamesWhatBlocks: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(germanFamily("DRAFT", { blocked: true })), changeId: "21" },
  parameters: { route: { pathname: "/price-migrations/edit/", query: { id: "21", step: "3" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "What the engine checked in v1" })).toBeInTheDocument();
    const blocking = page.getAllByText("Blocks the submission");
    await expect(blocking).toHaveLength(3);
    await expect(page.getByText(/a price migration raises the price, and €18\.99 is not above the price in force/)).toBeInTheDocument();
    await expect(page.getByText(/already changes this price/)).toBeInTheDocument();
    // Each finding leads back to the step that fixes it: the price and the overlap to the first, the dates to the second.
    await expect(page.getAllByRole("button", { name: "Go to step 1, New price" })).toHaveLength(2);
    await expect(page.getByRole("button", { name: "Go to step 2, Dates" })).toBeInTheDocument();
    await expect(page.getByText("v1 cannot be submitted until the blocking findings are fixed. Fixing them makes a new version, checked again.")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: /^Submit/ })).toBeNull();
  },
};

export const ACheckedVersionGoesToFinance: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(germanFamily("VALIDATED")), changeId: "21" },
  parameters: { route: { pathname: "/price-migrations/edit/", query: { id: "21", step: "3" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByLabelText("The change in business words")).toHaveTextContent("Germany, Family: from €18.99 to €20.99 for new subscribers from 1 December 2026");
    await expect(page.getByText("Finance must sign: conditions 1 and 5 of §7.3.", { selector: "span" })).toBeInTheDocument();
    // The simulation in short: the book's numbers per subscription (§8.7).
    await expect(await page.findByText(/net of VAT €15\.96 becomes €17\.64, and the artists' share €9\.58 becomes €10\.58/)).toBeInTheDocument();
    await expect(page.getByText(/If 90% of the 8,412 existing subscribers accept \(an illustrative assumption\)/)).toBeInTheDocument();
    await userEvent.type(page.getByLabelText("Why the price rises. Optional."), "Family costs us more per seat.");
    await userEvent.click(page.getByRole("button", { name: "Submit v1 for approval" }));
    await expect(await page.findByText("v1 is in approval.")).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Open the approval page" })).toHaveAttribute("href", "/price-migrations/approval/?id=21");
    await waitFor(() => {
      const sent = args.gateway.calls.find((call) => call.operation === "SubmitChange");
      expect(sent?.variables).toEqual({ changeId: "21", version: 1, authorReason: "Family costs us more per seat." });
      expect(sent?.idempotencyKey).toMatch(/^submit-change:/);
    });
  },
};

export const MarketingReadsItLocked: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(germanFamily("IN_APPROVAL")), changeId: "21" },
  parameters: { route: { pathname: "/price-migrations/edit/", query: { id: "21", step: "1" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/The commercial lead writes price migrations \(§12\)\. As Marketing you read this one, with its fields read-only\./)).toBeInTheDocument();
    await expect(page.getByLabelText("Migration name")).toBeDisabled();
    await expect(page.getByLabelText("New price in Germany, VAT included")).toBeDisabled();
    await expect(page.queryByRole("button", { name: "Save draft" })).toBeNull();
    await expect(page.queryByRole("button", { name: /Fill in/ })).toBeNull();
  },
};
