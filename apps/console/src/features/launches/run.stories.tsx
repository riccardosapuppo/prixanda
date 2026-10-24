// A launch's timeline for three people. Marketing reads a launch that
// recovered from a failed publish: its five steps, the publish step's two
// attempts, the catalog that went live, how it ended and the audit events it
// wrote; the same launch once its campaign was suspended, where today's state
// is kept apart from what the launch published, and the page says they
// differ; and a failed one, with why it stopped, the catalog of before still
// live, and a lock where the on-call engineer's actions would be. The on-call
// engineer tries the failed launch again after a confirmation that names the
// run, and cannot give it up without a reason.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { launchEvents, passLaunch } from "../../stories/launches.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { LaunchRunScreen } from "./run.tsx";

/**
 * The launch as the engine answers it, and the log around it. suspended: the
 * campaign was suspended after the launch published, and the engine published
 * catalog #431 without it.
 */
function gatewayFor(shape: "recovered" | "failed" | "waiting", options: { readonly suspended?: boolean } = {}) {
  let state: "as-is" | "retried" | "cancelled" = "as-is";
  // The newest catalog the log says was published: the launch's own, the one of before, or the one after the suspension.
  const liveCatalog = options.suspended ? "431" : shape === "recovered" ? "418" : "417";
  const launch = () => {
    const base = passLaunch(shape);
    const at = options.suspended ? { ...base, change: { ...base.change, state: "SUSPENDED" as const } } : base;
    if (state === "retried") return { ...at, state: "RUNNING" as const, finishedAt: null, retryAt: null, resolution: null };
    if (state === "cancelled") return { ...at, state: "CANCELLED" as const, change: { ...at.change, state: "CANCELLED" as const }, resolution: "cancelled by on-call-1: the price is wrong in Italy" };
    return at;
  };
  return fakeGateway({
    LaunchRun: () => ({ launch: launch(), markets: MARKETS }),
    AuditEvents: (variables: { filter: { subject?: string; action?: string } }) => variables.filter.action === "catalog.published"
      ? {
        auditEvents: {
          nodes: [{
            seq: "40", at: "2026-10-27T10:12:00Z", actor: "activation", actorRole: "SYSTEM", action: "catalog.published", subject: `catalog:${liveCatalog}`,
            requestId: "launch-19", reason: null, body: "{}", previousHash: "00".repeat(32), hash: `${"4".repeat(8)}${"0".repeat(56)}`,
          }],
          next: "40",
        },
      }
      : { auditEvents: { nodes: launchEvents(shape).filter((event) => event.subject === variables.filter.subject), next: null } },
    RetryLaunch: () => {
      state = "retried";
      return { retryLaunch: { __typename: "LaunchRun", ...launch() } };
    },
    CancelLaunch: () => {
      state = "cancelled";
      return { cancelLaunch: { __typename: "LaunchRun", ...launch() } };
    },
  });
}

function Timeline({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <LaunchRunScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Launch timeline",
  component: Timeline,
  parameters: { route: { pathname: "/launches/run/", query: { id: "12" } } },
} satisfies Meta<typeof Timeline>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ALaunchThatRecoveredFromAFailedPublish: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor("recovered") },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: "Launch timeline: launch-12", level: 1 })).toBeInTheDocument();
    await expect(page.getByText("5 done")).toBeInTheDocument();
    await expect(page.getByText("attempt 2 of 5")).toBeInTheDocument();
    const live = within(page.getByRole("region", { name: "Live now" }));
    await expect(await live.findByText("#418")).toBeInTheDocument();
    await expect(live.getByText("Student Autumn Pass v3 is live on the site.")).toBeInTheDocument();
    const left = within(page.getByRole("region", { name: "What this launch published" }));
    await expect(left.getByText("It published catalog #418, with the change in it, in one piece, on its publish step's attempt 2 of 5.")).toBeInTheDocument();
    await expect(page.getByText(/published at 26 Oct 08:59:05 Rome, on the publish step's second attempt/)).toBeInTheDocument();
    const events = within(page.getByRole("region", { name: "Audit events" }));
    await expect(await events.findByText("catalog.published")).toBeInTheDocument();
    await expect(events.getByRole("link", { name: "#14" })).toHaveAttribute("href", "/audit/?seq=14");
    await expect(page.queryByRole("button", { name: /Try again/ })).toBeNull();
    await expect(page.getByText(/Published: there is nothing to try again/)).toBeInTheDocument();
  },
};

export const ACampaignSuspendedSinceIsNotLive: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor("recovered", { suspended: true }) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const live = within(await page.findByRole("region", { name: "Live now" }));
    await expect(await live.findByText("#431")).toBeInTheDocument();
    await expect(live.getByText("Student Autumn Pass v3 is suspended: it is not on the site.")).toBeInTheDocument();
    await expect(live.getByText("Not what this launch left: it published catalog #418 with the change live; since then the change was suspended, and catalog #431 is the live one.")).toBeInTheDocument();
    // What the launch published stays as it happened.
    const left = within(page.getByRole("region", { name: "What this launch published" }));
    await expect(left.getByText("#418")).toBeInTheDocument();
    await expect(live.queryByText(/live on the site/)).toBeNull();
  },
};

export const MarketingReadsAFailedLaunch: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor("failed") },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("alert")).toHaveTextContent("Why it stopped");
    const live = within(page.getByRole("region", { name: "Live now" }));
    await expect(await live.findByText("#417")).toBeInTheDocument();
    await expect(live.getByText("Student Autumn Pass v3 is scheduled, not on the site yet.")).toBeInTheDocument();
    const left = within(page.getByRole("region", { name: "What this launch published" }));
    await expect(left.getByText("Nothing: catalog #417 stayed live, and no part of the change reached the site.")).toBeInTheDocument();
    await expect(page.getByText("2 done, 1 failed, 2 to do")).toBeInTheDocument();
    await expect(page.getByText("The on-call engineer tries again or gives up a launch that stopped. As Marketing you read it.")).toBeInTheDocument();
    await expect(page.queryByRole("button", { name: /Try again|Give up/ })).toBeNull();
    await expect(page.getByText("A step failed 5 times")).toBeInTheDocument();
  },
};

export const TheOnCallEngineerTriesItAgain: Story = {
  args: { viewer: PEOPLE["onCall"]!, gateway: gatewayFor("failed") },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Try again from the publish step" }));
    await userEvent.type(page.getByLabelText("What was done so that it can go through (optional)"), "The database is back after the failover.");
    await userEvent.click(page.getByRole("button", { name: "Try launch-12 again" }));
    const dialog = await page.findByRole("dialog", { name: "Try launch-12 again?" });
    await expect(dialog).toHaveTextContent("The engine runs the launch of Student Autumn Pass v3 again from its publish step, now.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Try launch-12 again" }));
    await expect(await page.findByText(/launch-12 runs again from its publish step/)).toBeInTheDocument();
    const sent = args.gateway.calls.filter((call) => call.operation === "RetryLaunch");
    await expect(sent).toHaveLength(1);
    await expect(sent[0]?.variables).toEqual({ launchId: "12", reason: "The database is back after the failover." });
    await expect(sent[0]?.idempotencyKey).toMatch(/^retry-launch:/);
  },
};

export const GivingUpALaunchTakesAReason: Story = {
  args: { viewer: PEOPLE["onCall"]!, gateway: gatewayFor("waiting") },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText("Why it waits")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Give up the launch" }));
    await userEvent.click(page.getByRole("button", { name: "Give up launch-12" }));
    await expect(page.getByText("Write why the launch is given up: it goes into the audit log, and the change is cancelled with it.")).toBeInTheDocument();
    await expect(page.getByLabelText("Why the launch is given up")).toHaveFocus();
    await expect(args.gateway.calls.some((call) => call.operation === "CancelLaunch")).toBe(false);
    await userEvent.type(page.getByLabelText("Why the launch is given up"), "the price is wrong in Italy");
    await userEvent.click(page.getByRole("button", { name: "Give up launch-12" }));
    const dialog = await page.findByRole("dialog", { name: "Give up launch-12?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Give up launch-12" }));
    await expect(await page.findByText(/launch-12 was given up and Student Autumn Pass v3 is cancelled/)).toBeInTheDocument();
    const sent = args.gateway.calls.filter((call) => call.operation === "CancelLaunch");
    await expect(sent[0]?.variables).toEqual({ launchId: "12", reason: "the price is wrong in Italy" });
  },
};
