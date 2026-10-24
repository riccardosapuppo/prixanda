// The audit log as the auditor reads it: a verification speaks of the head it
// was given, a head typed afterwards clears it; Marketing reads the log, the
// page says §11.4 word for word, and a lock stands where the verification and
// the export would be. A link to an event older than the newest fifty (from
// an approval or a launch) reads on until it, and highlights it; a link to an
// event the log does not hold says so.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { GatewayError } from "../../lib/gateway.ts";
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

/**
 * A log of 120 events, read as the engine pages it: newest first, each page
 * after the last sequence number of the one before. failOnce: the page after
 * #21 fails the first time it is asked for, as when the engine does not reply.
 */
function longLog(options: { readonly failOnce?: boolean } = {}) {
  let failed = false;
  const all = Array.from({ length: 120 }, (_, index) => {
    const seq = 120 - index;
    return event(seq, seq % 2 ? "change.version_saved" : "change.validated", "MARKETING", "marketing-1", new Date(Date.UTC(2026, 9, 24, 8, 0) - index * 60_000).toISOString(), { change: 7, version: seq });
  });
  return fakeGateway({
    People: () => ({ people: Object.values(PEOPLE).map((person) => ({ id: person.personId, label: person.label, roles: person.roles })) }),
    AuditEvents: (variables: { first: number; after: string | null }) => {
      if (options.failOnce && variables.after === "21" && !failed) {
        failed = true;
        throw new GatewayError("ENGINE_UNAVAILABLE", "The engine did not reply in time.", "console:00000000-aaaa-4bbb-8ccc-000000000021");
      }
      const older = variables.after === null ? all : all.filter((entry) => Number(entry.seq) < Number(variables.after));
      const page = older.slice(0, variables.first);
      return { auditEvents: { nodes: page, next: older.length > variables.first ? (page.at(-1)?.seq ?? null) : null } };
    },
  });
}

export const ALinkToAnOlderEventReadsOnUntilIt: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: longLog() },
  parameters: { route: { pathname: "/audit/", query: { seq: "11" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("Event #11, the one the link names, is highlighted below.", {}, { timeout: 10_000 })).toBeInTheDocument();
    const row = canvasElement.ownerDocument.getElementById("event-11");
    await expect(row).toHaveAttribute("aria-current", "true");
    // Three pages of fifty: the newest fifty, the fifty before them, and the one holding #11.
    const pages = args.gateway.calls.filter((call) => call.operation === "AuditEvents").map((call) => (call.variables as { after: string | null }).after);
    await expect(pages).toEqual([null, "71", "21"]);
  },
};

export const ALinkToAnEventTheLogDoesNotHold: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: longLog() },
  parameters: { route: { pathname: "/audit/", query: { seq: "500" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("alert")).toHaveTextContent("Event #500 is not in the log.");
    await expect(page.getByText("120", { selector: "th" })).toBeInTheDocument();
  },
};

export const AFailedPageStopsTheSearchUntilTryAgain: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: longLog({ failOnce: true }) },
  parameters: { route: { pathname: "/audit/", query: { seq: "11" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Event #11 is not reached yet: a page of older events did not load/, {}, { timeout: 10_000 })).toBeInTheDocument();
    // The page that failed was asked for once: the search waits for the person instead of asking again and again.
    const asked = () => args.gateway.calls.filter((call) => call.operation === "AuditEvents" && (call.variables as { after: string | null }).after === "21").length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(asked()).toBe(1);
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect(await page.findByText("Event #11, the one the link names, is highlighted below.")).toBeInTheDocument();
    await expect(asked()).toBe(2);
  },
};
