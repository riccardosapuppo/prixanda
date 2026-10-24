// The approval page for three people: the author finds no button and reads
// why; the commercial lead cannot sign what only Finance may; Finance signs
// v3 by its fingerprint after the confirmation, with one idempotency key.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FINGERPRINT_V3, MARKETS, simulation, studentPass } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { ApprovalScreen } from "./approval.tsx";

function gatewayFor() {
  let approved = false;
  return fakeGateway({
    Change: () => ({ change: approved ? studentPass("APPROVED", true) : studentPass() }),
    AuditEvents: () => ({ auditEvents: { nodes: [], next: null } }),
    Markets: () => ({ markets: MARKETS }),
    SimulateOffer: () => ({ simulateOffer: simulation(5500) }),
    ApproveChange: () => {
      approved = true;
      return { approveChange: { __typename: "Change", ...studentPass("APPROVED", true) } };
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
  },
};

export const TheCommercialLeadCannotSignForFinance: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("As Commercial lead you can't sign this one: it needs Finance (conditions 2 and 4).")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: /^Approve/ })).toBeNull();
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
