// Launches for the stories, shaped as the engine answers them (launches.py):
// the Student Autumn Pass launched at 09:00 in Rome on Monday 26 October,
// due a minute before, its five steps ten-odd milliseconds apart, except the
// five seconds the engine waits after a failed publish.
import type { AuditEventsQuery, LaunchRunQuery } from "../graphql/generated.ts";

export type LaunchDetail = NonNullable<LaunchRunQuery["launch"]>;
type Event = AuditEventsQuery["auditEvents"]["nodes"][number];

const PURPOSE: Readonly<Record<string, string>> = {
  check: "The change is still scheduled at its approved version, and nothing clashes with it.",
  prepare: "The new catalog snapshot is written, not yet live.",
  publish: "In one transaction: the change becomes active, the snapshot goes live, and the audit events and the site's notice are written.",
  notify: "The outbox delivers the notice to the site's inbox.",
  verify: "The live catalog, or the price list, shows the change as approved.",
};

const CUT = "the connection to the database was cut inside the publish transaction; it rolled back, and catalog #417 stays live";

type Step = LaunchDetail["steps"][number];
const step = (name: string, state: Step["state"], startedAt: string | null, finishedAt: string | null, attempts: number, error: string | null = null, facts: Record<string, string> = {}): Step => ({
  name, purpose: PURPOSE[name] ?? "", state, startedAt, finishedAt, attempts, error, facts: Object.entries(facts).map(([name, value]) => ({ name, value })),
});

/** The pass's launch: recovered after one failed publish, failed after five, or waiting to try the publish step again. */
export function passLaunch(shape: "recovered" | "failed" | "waiting"): LaunchDetail {
  const base = {
    id: "12", run: "launch-12", title: "Student Autumn Pass", kind: "OFFER" as const, version: 3,
    change: { id: "7", currentVersion: 3, state: shape === "recovered" ? "ACTIVE" as const : "SCHEDULED" as const },
    starts: { market: "IT", local: "2026-10-26T09:00", utc: "2026-10-26T08:00:00Z" },
    dueAt: "2026-10-26T07:59:00Z", startedAt: "2026-10-26T07:59:00.080Z", snapshotBefore: "417",
  };
  const check = step("check", "DONE", "2026-10-26T07:59:00.080Z", "2026-10-26T07:59:00.150Z", 1);
  const prepare = step("prepare", "DONE", "2026-10-26T07:59:00.150Z", "2026-10-26T07:59:00.410Z", 1, null, { snapshot: "418", offers: "1 added in Italy" });
  if (shape === "recovered") {
    return {
      ...base, state: "DONE", finishedAt: "2026-10-26T07:59:05.970Z", currentStep: null, attempts: 6, cause: null, retryAt: null,
      resolution: "published at 2026-10-26T07:59:05.530Z, on the publish step's second attempt", snapshotAfter: "418",
      steps: [
        check, prepare,
        step("publish", "DONE", "2026-10-26T07:59:05.420Z", "2026-10-26T07:59:05.530Z", 2, null, { snapshot: "418", change: "7" }),
        step("notify", "DONE", "2026-10-26T07:59:05.530Z", "2026-10-26T07:59:05.610Z", 1),
        step("verify", "DONE", "2026-10-26T07:59:05.610Z", "2026-10-26T07:59:05.970Z", 1),
      ],
      auditEventSeqs: ["11", "13", "14"],
      incidents: [],
    };
  }
  const failedPublish = shape === "failed"
    ? step("publish", "FAILED", "2026-10-26T08:02:35.410Z", "2026-10-26T08:02:35.520Z", 5, CUT)
    : step("publish", "FAILED", "2026-10-26T07:59:00.410Z", "2026-10-26T07:59:00.520Z", 1, CUT);
  return {
    ...base,
    state: shape === "failed" ? "FAILED" : "RUNNING",
    finishedAt: shape === "failed" ? "2026-10-26T08:02:35.520Z" : null,
    currentStep: "publish",
    attempts: shape === "failed" ? 7 : 3,
    cause: CUT,
    retryAt: shape === "waiting" ? "2026-10-26T07:59:05.520Z" : null,
    resolution: null,
    snapshotAfter: null,
    steps: [check, prepare, failedPublish, step("notify", "PENDING", null, null, 0), step("verify", "PENDING", null, null, 0)],
    auditEventSeqs: ["11"],
    incidents: shape === "failed"
      ? [{ id: "3", kind: "FAILED", state: "OPEN", summary: "launch-12 failed at its publish step after 5 attempts: nothing was published, and Student Autumn Pass stays scheduled.", openedAt: "2026-10-26T08:02:35.520Z", closedAt: null, resolution: null }]
      : [],
  };
}

const HASH = (seed: string) => `${seed.repeat(8).slice(0, 8)}${"0".repeat(56)}`;

/** The audit events a launch wrote, as the log returns them for its change. */
export function launchEvents(shape: "recovered" | "failed" | "waiting"): Event[] {
  const event = (seq: string, action: string, at: string, subject = "change:7"): Event => ({
    seq, at, actor: "activation", actorRole: "SYSTEM", action, subject, requestId: "launch-12", reason: null, body: "{}", previousHash: "00".repeat(32), hash: HASH(seq),
  });
  const events = [event("11", "launch.started", "2026-10-26T07:59:00.080Z")];
  if (shape === "recovered") events.push(event("13", "change.activated", "2026-10-26T07:59:05.530Z"), event("14", "catalog.published", "2026-10-26T07:59:05.530Z", "catalog:418"));
  return events.reverse();
}
