// A campaign for the fans of an artist (business book §14.2): the example of
// the book fills the rule and reads it back in words, the page beside it
// says who sees it, a search finds another artist in the catalog; a rule
// that cannot mean anything stops step 1 on its field; the check counts the
// fans in the listening data; and a role that does not read the catalog's
// artists reads the artist by number, with no request for them.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { artistsAnswer, nordflurRelease } from "../../stories/fans.ts";
import { MARKETS, PLANS_IT } from "../../stories/fixtures.ts";
import { PLANS_DE } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { Wizard } from "./wizard.tsx";

function gatewayFor() {
  return fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: (variables: { market: string }) => ({ plans: variables.market === "DE" ? PLANS_DE : PLANS_IT }),
    Artists: (variables) => artistsAnswer(variables),
    Change: () => ({ change: nordflurRelease("VALIDATED") }),
  });
}

function FansCampaign({ viewer, gateway, changeId }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor>; readonly changeId: string | null }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <Wizard changeId={changeId} />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Guided creation/Fans of an artist",
  component: FansCampaign,
  parameters: { route: { pathname: "/campaigns/new/", query: {} } },
} satisfies Meta<typeof FansCampaign>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheFansOfAnArtistFromTheCatalog: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the Nordflur release" }));
    await expect(page.getByRole("checkbox", { name: /Only the fans of an artist/ })).toBeChecked();
    await expect(await page.findByRole("radio", { name: /^Doppelfenster/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Doppelfenster/ })).toHaveAccessibleName(/Kellerlicht · Germany · Nordflur, 6 November 2026/);
    await expect(page.getByLabelText("Hours played")).toHaveValue("3");
    await expect(page.getByLabelText("Window")).toHaveValue("30");
    await expect(await page.findByText("Listeners on Free in Germany who played Doppelfenster for more than 3 hours in the last 30 days.")).toBeInTheDocument();
    await expect(within(page.getByRole("figure")).getByText(/Fans of Doppelfenster on Free in Germany/)).toBeInTheDocument();
    await expect(page.getByText(/the engine counts in the data once the version is saved and checked, in step 5/)).toBeInTheDocument();

    // Another artist, found by a part of the name; the chosen one stays in view until another is chosen.
    await userEvent.type(page.getByRole("searchbox", { name: "Artist" }), "hal");
    // The first page by name stays on screen until the search's answer replaces it.
    await expect(await page.findByText("1 artist with “hal” in their name. The one chosen, Doppelfenster, stays first.")).toBeInTheDocument();
    await expect(page.queryByRole("radio", { name: /^Pinewire/ })).toBeNull();
    await expect(page.getByRole("radio", { name: /^Halde/ })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: /^Doppelfenster/ })).toBeChecked();
    await userEvent.click(page.getByRole("radio", { name: /^Halde/ }));
    await expect(await page.findByText("Listeners on Free in Germany who played Halde for more than 3 hours in the last 30 days.")).toBeInTheDocument();
    await expect(args.gateway.calls.some((call) => call.operation === "Artists" && (call.variables as { search?: string }).search === "hal")).toBe(true);
  },
};

export const TheRuleStopsOnWhatCannotMeanAnything: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.type(await page.findByLabelText("Campaign name"), "Nordflur release");
    await userEvent.click(page.getByRole("checkbox", { name: /^Germany/ }));
    await userEvent.selectOptions(page.getByLabelText("Plan"), "individual");
    await userEvent.click(page.getByRole("radio", { name: /Listeners on Free now/ }));
    await userEvent.click(page.getByRole("checkbox", { name: /Only the fans of an artist/ }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await expect(await page.findByText("Choose the artist whose fans it is for.")).toBeInTheDocument();
    await expect(page.getByRole("searchbox", { name: "Artist" })).toHaveFocus();
    await userEvent.type(page.getByLabelText("Hours played"), "800");
    await userEvent.tab();
    await expect(await page.findByText("Nobody plays more than 24 hours a day: in 30 days, fewer than 720 hours.")).toBeInTheDocument();
    await expect(page.getByLabelText("Hours played")).toHaveAttribute("aria-invalid", "true");
  },
};

export const TheCheckCountsTheFansInTheListening: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(), changeId: "12" },
  parameters: { route: { pathname: "/campaigns/edit/", query: { id: "12", step: "5" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByLabelText("The change in business words")).toHaveTextContent("Free listeners with more than 3 hours of Doppelfenster in 30 days; 3,840 eligible");
    const counted = page.getByText(/people eligible right now, counted in the simulated data by the engine/);
    await expect(counted).toHaveTextContent("3,840 people eligible right now, counted in the simulated data by the engine: their listening of the 30 full days before today, in each market's calendar.");
  },
};

export const ARoleThatDoesNotReadTheArtists: Story = {
  args: { viewer: PEOPLE["auditor"]!, gateway: gatewayFor(), changeId: "12" },
  parameters: { route: { pathname: "/campaigns/edit/", query: { id: "12", step: "1" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Artist #4\. Marketing, the commercial lead and Finance read the catalog's artists; the campaign's sentence in step 5 names them\./)).toBeInTheDocument();
    await expect(page.getByRole("checkbox", { name: /Only the fans of an artist/ })).toBeDisabled();
    await expect(page.getByLabelText("Hours played")).toBeDisabled();
    await waitFor(() => expect(args.gateway.calls.length).toBeGreaterThan(0));
    await expect(args.gateway.calls.some((call) => call.operation === "Artists")).toBe(false);
  },
};
