// The approval page for three people: the author finds no button and reads
// why; the commercial lead cannot sign what only Finance may, and still sends
// it back to its author with a reason (sending back is not signing); Finance
// signs v3 by its fingerprint after the confirmation, with one idempotency key.
// Without the markets the page shows no time and schedules nothing: a start
// read in UTC instead of Rome's would be an hour off.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FINGERPRINT_V3, MARKETS, simulation, studentPass } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import { GatewayError } from "../../lib/gateway.ts";
import type { Viewer } from "../../lib/react/session.tsx";
import { ApprovalScreen } from "./approval.tsx";

function gatewayFor() {
  let approved = false;
  let sentBack = false;
  return fakeGateway({
    Change: () => ({ change: approved ? studentPass("APPROVED", true) : sentBack ? studentPass("DRAFT") : studentPass() }),
    AuditEvents: () => ({ auditEvents: { nodes: [], next: null } }),
    Markets: () => ({ markets: MARKETS }),
    SimulateOffer: () => ({ simulateOffer: simulation(5500) }),
    ApproveChange: () => {
      approved = true;
      return { approveChange: { __typename: "Change", ...studentPass("APPROVED", true) } };
    },
    RejectChange: () => {
      sentBack = true;
      return { rejectChange: { __typename: "Change", ...studentPass("DRAFT") } };
    },
  });
}

/** An approved campaign whose markets fail to load the first time, and load when the person tries again. */
function marketsFailOnce() {
  let asked = 0;
  return fakeGateway({
    Change: () => ({ change: studentPass("APPROVED", true) }),
    AuditEvents: () => ({ auditEvents: { nodes: [], next: null } }),
    Markets: () => {
      asked += 1;
      if (asked === 1) throw new GatewayError("UNREACHABLE", "The gateway did not answer.", "console:markets-1");
      return { markets: MARKETS };
    },
    SimulateOffer: () => ({ simulateOffer: simulation(5500) }),
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
  title: "Screens/Approval",
  component: Approval,
  parameters: { route: { pathname: "/campaigns/approval/", query: { id: "7" } } },
} satisfies Meta<typeof Approval>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheAuthorFindsNoButton: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("You wrote v3. Someone else has to approve it.")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: /^Approve/ })).toBeNull();
    await expect(page.getByLabelText("Fingerprint of v3")).toHaveTextContent(FINGERPRINT_V3);
    // Where to change person, in words true at every width: "Signed in as" is in the rail and in the bar on top alike.
    await expect(page.getByText(/Choose another person under “Signed in as” to see what their role can do\./)).toHaveTextContent("Demo role: Marketing. Choose another person under “Signed in as” to see what their role can do.");
  },
};

export const TheCommercialLeadSendsBackWhatOnlyFinanceSigns: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("As Commercial lead you can't sign this one: it needs Finance (conditions 2 and 4).")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: /^Approve/ })).toBeNull();
    await expect(page.getByText("You can still send v3 back to its author, with a reason.")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Send back with a reason" }));
    await userEvent.type(page.getByLabelText("Why v3 goes back to its author"), "Keep it to Italy until the floor is agreed.");
    await userEvent.click(page.getByRole("button", { name: "Send v3 back" }));
    const dialog = await page.findByRole("dialog", { name: "Send v3 back to its author?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send v3 back" }));
    await expect(await page.findByText("Sent v3 back to draft, with your reason.")).toBeInTheDocument();
    const sent = args.gateway.calls.filter((call) => call.operation === "RejectChange");
    await expect(sent).toHaveLength(1);
    await expect(sent[0]?.variables).toEqual({ changeId: "7", version: 3, reason: "Keep it to Italy until the floor is agreed." });
    await expect(sent[0]?.idempotencyKey).toMatch(/^reject-change:/);
  },
};

export const FinanceApprovesByTheFingerprint: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Approve v3 as Finance" }));
    const dialog = await body.findByRole("dialog", { name: "Approve v3 as Finance?" });
    await expect(dialog).toHaveTextContent(FINGERPRINT_V3);
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve v3" }));
    await expect(await page.findByText(/Approved v3 as Finance/)).toBeInTheDocument();
    const approvals = () => args.gateway.calls.filter((call) => call.operation === "ApproveChange");
    await waitFor(() => expect(approvals()).toHaveLength(1));
    await expect(approvals()[0]?.variables).toEqual({ changeId: "7", version: 3, fingerprint: FINGERPRINT_V3 });
    await expect(approvals()[0]?.idempotencyKey).toMatch(/^approve-change:/);
  },
};

export const WithoutTheMarketsItShowsNoTimeAndSchedulesNothing: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: marketsFailOnce() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/^The markets did not load, and with them their time zones/)).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: "Schedule the launch" })).toBeNull();
    await expect(page.queryByText(/UTC\)/)).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    // With the markets, Italy's 09:00 is 08:00 UTC that day, not 09:00 UTC.
    await expect(await page.findByText("Approved. It starts only once it is scheduled: Italy: Mon 26 Oct 2026, 09:00 Rome (08:00 UTC).")).toBeInTheDocument();
    await expect(page.getByRole("button", { name: "Schedule the launch" })).toBeEnabled();
  },
};
