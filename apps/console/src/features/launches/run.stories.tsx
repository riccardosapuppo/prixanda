// A launch's timeline for three people. Marketing reads a launch that
// recovered from a failed publish: its five steps, the publish step's two
// attempts, the catalog that went live, how it ended and the audit events it
// wrote; the same launch once its campaign was suspended, where today's state
// is kept apart from what the launch published, and the page says they
// differ; and a failed one, with why it stopped, the catalog of before still
// live, and a lock where the on-call engineer's actions would be. The on-call
// engineer tries the failed launch again after a confirmation that names the
// run, and cannot give it up without a reason. With the page left open, what
// is live today follows a later catalog and a suspension, and a catalog
// published in the launch's last seconds shows once the launch is done.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { MARKETS } from "../../stories/fixtures.ts";
import { launchEvents, passLaunch } from "../../stories/launches.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { WatchEvery } from "../../lib/react/watch.tsx";
import { LaunchRunScreen } from "./run.tsx";

/** The log's newest catalog.published: the catalog the engine put live last. */
function publishedEvent(catalog: string) {
  return {
    seq: "40", at: "2026-10-27T10:12:00Z", actor: "activation", actorRole: "SYSTEM", action: "catalog.published", subject: `catalog:${catalog}`,
    requestId: "launch-19", reason: null, body: "{}", previousHash: "00".repeat(32), hash: `${"4".repeat(8)}${"0".repeat(56)}`,
  };
}

/** The audit events of a launch, by subject; the newest catalog published, as the log says it now. */
function auditEvents(liveCatalog: () => string) {
  return (variables: { filter: { subject?: string; action?: string } }) => variables.filter.action === "catalog.published"
    ? { auditEvents: { nodes: [publishedEvent(liveCatalog())], next: "40" } }
    : { auditEvents: { nodes: launchEvents("recovered").filter((event) => event.subject === variables.filter.subject), next: null } };
}

/**
 * A launch that published catalog #418, its page left open: another launch
 * then publishes #419 (publishLater), and the campaign is suspended, which
 * puts #420 live without it (suspend).
 */
function afterTheLaunch() {
  let liveCatalog = "418";
  let suspended = false;
  const gateway = fakeGateway({
    LaunchRun: () => {
      const base = passLaunch("recovered");
      return { launch: suspended ? { ...base, change: { ...base.change, state: "SUSPENDED" as const } } : base, markets: MARKETS };
    },
    AuditEvents: auditEvents(() => liveCatalog),
  });
  return Object.assign(gateway, {
    publishLater: () => {
      liveCatalog = "419";
    },
    suspend: () => {
      suspended = true;
      liveCatalog = "420";
    },
  });
}

/**
 * A launch read while it runs, whose publish lands in its last seconds: the
 * second reading finds it done, catalog #418 published a moment before it
 * answers; until then the log said #417.
 */
function publishedAtTheEnd() {
  let readings = 0;
  let liveCatalog = "417";
  return fakeGateway({
    LaunchRun: () => {
      readings += 1;
      if (readings === 1) return { launch: passLaunch("waiting"), markets: MARKETS };
      return new Promise((resolve) => {
        setTimeout(() => {
          liveCatalog = "418";
          resolve({ launch: passLaunch("recovered"), markets: MARKETS });
        }, 300);
      });
    },
    AuditEvents: auditEvents(() => liveCatalog),
  });
}

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

function Timeline({ viewer, gateway, watchEvery }: {
  readonly viewer: Viewer;
  readonly gateway: ReturnType<typeof gatewayFor> & { readonly publishLater?: () => void; readonly suspend?: () => void };
  readonly watchEvery?: number;
}) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      {watchEvery ? <WatchEvery ms={watchEvery}><LaunchRunScreen /></WatchEvery> : <LaunchRunScreen />}
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

export const LiveNowFollowsALaterCatalogAndASuspension: Story = {
  // The gateway's pace is half a minute; the story's, a moment.
  args: { viewer: PEOPLE["marketing"]!, gateway: afterTheLaunch(), watchEvery: 300 },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const live = within(await page.findByRole("region", { name: "Live now" }));
    await expect(await live.findByText("#418")).toBeInTheDocument();
    // Another launch puts catalog #419 live while the page stays open.
    args.gateway.publishLater?.();
    await expect(await live.findByText("#419", {}, { timeout: 5_000 })).toBeInTheDocument();
    await expect(live.getByText("Catalog #419 is the live one now, published after this launch's #418; the change is still in it.")).toBeInTheDocument();
    // The campaign is suspended: catalog #420 goes live without it.
    args.gateway.suspend?.();
    await expect(await live.findByText("#420", {}, { timeout: 5_000 })).toBeInTheDocument();
    await expect(await live.findByText("Student Autumn Pass v3 is suspended: it is not on the site.", {}, { timeout: 5_000 })).toBeInTheDocument();
    await expect(await live.findByText(
      "Not what this launch left: it published catalog #418 with the change live; since then the change was suspended, and catalog #420 is the live one.",
      {},
      { timeout: 5_000 },
    )).toBeInTheDocument();
  },
};

export const ACatalogPublishedInTheLaunchsLastSecondsIsLive: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: publishedAtTheEnd() },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const live = within(await page.findByRole("region", { name: "Live now" }));
    await expect(await live.findByText("#417")).toBeInTheDocument();
    // Read done, its catalog published a moment before: the box reads the log once more as the launch stops running.
    await expect(await page.findByText("5 done", {}, { timeout: 5_000 })).toBeInTheDocument();
    await expect(await live.findByText("#418", {}, { timeout: 3_000 })).toBeInTheDocument();
    await expect(live.queryByText(/is the live one now/)).toBeNull();
  },
};
