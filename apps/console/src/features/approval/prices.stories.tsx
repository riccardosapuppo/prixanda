// The approval page for the prices the commercial lead writes. Finance signs
// the German Family rise by its fingerprint, with the rules of Germany beside
// the evidence, the law apart from the music service's choice, and the
// simulation in short; Finance does not schedule what it approved. The
// commercial lead schedules an approved pass. The on-call engineer finds no
// suspension for a migration that started: its price is in the price list,
// never edited (§4.2), and the page leads to its progress instead.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { type Change, familySimulation, germanFamily, giftPass, MID_WINDOW, POLICIES } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { ApprovalScreen } from "./approval.tsx";

function gatewayFor(start: Change, after: Change) {
  let moved = false;
  return fakeGateway({
    Change: () => ({ change: moved ? after : start }),
    AuditEvents: () => ({ auditEvents: { nodes: [], next: null } }),
    Markets: () => ({ markets: MARKETS }),
    PriceChangePolicies: () => POLICIES,
    SimulateMigration: () => ({ simulateMigration: familySimulation(9000) }),
    LaunchRuns: () => ({ launches: { nodes: [], next: null } }),
    ApproveChange: () => {
      moved = true;
      return { approveChange: { __typename: "Change", ...after } };
    },
    ScheduleChange: () => {
      moved = true;
      return { scheduleChange: { __typename: "Change", ...after } };
    },
  });
}

function Approval({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <ApprovalScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Approval of a price",
  component: Approval,
  parameters: { route: { pathname: "/price-migrations/approval/", query: { id: "21" } } },
} satisfies Meta<typeof Approval>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FinanceSignsTheGermanRise: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor(germanFamily("IN_APPROVAL"), germanFamily("APPROVED", { signed: true })) },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("navigation", { name: "This price migration" })).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Progress" })).toHaveAttribute("href", "/price-migrations/progress/?id=21");
    const law = within(await page.findByRole("region", { name: "What the law asks" }));
    await expect(law.getByText(/silence counts as no/)).toBeInTheDocument();
    await expect(page.getByRole("region", { name: "What Rione chose" })).toHaveTextContent("The music service's choice, configurable per market; not a legal requirement.");
    await expect(await page.findByText(/net of VAT €15\.96 becomes €17\.64/)).toBeInTheDocument();
    await expect(page.getByRole("heading", { name: "Why the price rises, in the author's words" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Approve v1 as Finance" }));
    const dialog = within(await page.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Approve v1" }));
    await expect(await page.findByText(/Approved v1 as Finance/)).toBeInTheDocument();
    await waitFor(() => {
      const sent = args.gateway.calls.find((call) => call.operation === "ApproveChange");
      expect(sent?.variables).toEqual({ changeId: "21", version: 1, fingerprint: germanFamily().current.fingerprint });
    });
    // Approved: the commercial lead schedules it, Finance does not.
    await expect(await page.findByText("Approved. The commercial lead schedules the launch; Finance approves but does not schedule.")).toBeInTheDocument();
  },
};

export const TheCommercialLeadSchedulesAnApprovedPass: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(giftPass("APPROVED", { signed: true }), giftPass("SCHEDULED", { signed: true })) },
  parameters: { route: { pathname: "/passes/approval/", query: { id: "24" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "The pass, in short" })).toBeInTheDocument();
    await expect(page.getByRole("row", { name: /^Italy €29\.99 Mon 26 Oct 2026, 09:00 Rome \(08:00 UTC\), no end announced/ })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Schedule the launch" }));
    const dialog = within(await page.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Schedule the launch" }));
    await expect(await page.findByText(/Scheduled\. It starts at Italy: Mon 26 Oct 2026, 09:00 Rome/)).toBeInTheDocument();
    await waitFor(() => expect(args.gateway.calls.filter((call) => call.operation === "ScheduleChange")).toHaveLength(1));
  },
};

export const AMigrationThatStartedIsNotSuspended: Story = {
  args: { viewer: PEOPLE["onCall"]!, gateway: gatewayFor(germanFamily("ACTIVE", { signed: true, progress: MID_WINDOW }), germanFamily("ACTIVE", { signed: true, progress: MID_WINDOW })) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Started: the existing subscribers were asked/)).toBeInTheDocument();
    await expect(page.getByText("8,412 asked or told; 3,120 waiting, 4,987 accepted, 305 declined, 0 lapsed.")).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "See the progress" })).toHaveAttribute("href", "/price-migrations/progress/?id=21");
    await expect(page.queryByRole("button", { name: "Suspend it" })).toBeNull();
    await expect(page.getByText(/A price migration in force is not suspended/)).toBeInTheDocument();
  },
};
