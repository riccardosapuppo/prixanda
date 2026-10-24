// The audit log as the auditor reads it: a verification speaks of the head it
// was given, a head typed afterwards clears it; Marketing reads the log, the
// page says §11.4 word for word, and a lock stands where the verification and
// the export would be.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { AuditScreen } from "./audit.tsx";

const HEAD = "85de7a2b00588a5f1fd5394204399d759935e771001f9ff26ef426aa0d08c6c7";

const event = (seq: number, action: string, actorRole: string, actor: string, at: string, body: Record<string, unknown>, reason: string | null = null) => ({
  seq: String(seq), at, actor, actorRole, action, subject: "change:7", requestId: `console:0000000${seq}-aaaa-4bbb-8ccc-${String(seq).padStart(12, "0")}`, reason,
  body: JSON.stringify(body), previousHash: "00".repeat(32), hash: seq === 6 ? HEAD : `${String(seq).repeat(8).slice(0, 8)}${"0".repeat(56)}`,
});

function gatewayFor() {
  return fakeGateway({
    People: () => ({ people: Object.values(PEOPLE).map((person) => ({ id: person.personId, label: person.label, roles: person.roles })) }),
    AuditEvents: () => ({
      auditEvents: {
        nodes: [
          event(6, "change.approved", "FINANCE", "finance-1", "2026-10-24T08:31:55Z", { change: 7, version: 3, from: "in_approval", to: "approved" }),
          event(5, "change.submitted", "MARKETING", "marketing-1", "2026-10-23T15:20:05Z", { change: 7, version: 3, from: "validated", to: "in_approval" }, "We are buying students now."),
          event(4, "change.rejected", "FINANCE", "finance-1", "2026-10-22T14:26:09Z", { change: 7, version: 2, from: "in_approval", to: "draft" }, "Keep it to people who have never paid."),
        ],
        next: null,
      },
    }),
    VerifyAuditChain: (variables: { anchor: { seq: string; hash: string } | null }) => ({
      verifyAuditChain: variables.anchor === null || variables.anchor.hash === HEAD
        ? { ok: true, events: 6, head: { seq: "6", hash: HEAD }, brokenAt: null, why: null }
        : { ok: false, events: Number(variables.anchor.seq), head: null, brokenAt: variables.anchor.seq, why: "the chain no longer leads to the exported head: it was rewritten" },
    }),
    ExportAuditHead: () => ({ exportAuditHead: { __typename: "ChainHead", seq: "6", hash: HEAD } }),
  });
}

function Audit({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <AuditScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Audit log",
  component: Audit,
  parameters: { route: { pathname: "/audit/", query: {} } },
} satisfies Meta<typeof Audit>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheAuditorVerifiesAgainstTheHeadItGave: Story = {
  args: { viewer: PEOPLE["auditor"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("change.rejected")).toBeInTheDocument();
    const verify = page.getByRole("button", { name: "Verify the chain" });
    await userEvent.click(verify);
    await expect(await page.findByText(/Checked without an exported head/)).toBeInTheDocument();
    await userEvent.click(page.getByText("Check against an exported head"));
    await userEvent.type(page.getByLabelText("Event #"), "4");
    await expect(page.queryByText(/The chain holds/)).toBeNull();
    await userEvent.type(page.getByLabelText("Its hash (64 hexadecimal digits)"), "ab".repeat(32));
    await userEvent.click(verify);
    await expect(await page.findByRole("alert")).toHaveTextContent("Checked against the exported head #4 (abababab…)");
    await userEvent.click(page.getByRole("button", { name: "Export the head" }));
    await expect(await page.findByText("Exported head: event #6")).toBeInTheDocument();
    await expect(page.getByLabelText("Event #")).toHaveValue("6");
    await userEvent.click(verify);
    await expect(await page.findByText(/It leads to the exported head #6 \(85de7a2b…\), the head this check was given\./)).toBeInTheDocument();
  },
};

export const MarketingReadsAndFindsTheLocks: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("Keep it to people who have never paid.")).toBeInTheDocument();
    await expect(page.getByText("Everyone on the team reads the log, so any decision can be traced from any seat; the auditor exports it, and the auditor and the on-call engineer verify the chain. Nobody can change it through Plancia.")).toBeInTheDocument();
    await expect(page.getByText("The auditor and the on-call engineer verify the chain. As Marketing you read every event below.")).toBeInTheDocument();
    await expect(page.getByText("The auditor exports the log, with the head of the chain kept outside the database. As Marketing you read it, like everyone on the team.")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: "Verify the chain" })).toBeNull();
  },
};
