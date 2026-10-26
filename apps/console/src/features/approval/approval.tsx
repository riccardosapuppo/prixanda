"use client";
// The approval of a change (business book §7): on the left the evidence (the
// change in business words, what changed since the last version, who has to
// sign and why, the simulation in short, the author's own reason, the
// version and its fingerprint, the history), on the right the decision for
// the person looking. The author does not find the approve button, and the
// page says why; the server would refuse it anyway. Approving and sending
// back are confirmed in a dialog that names the version and its fingerprint.
//
// After approval the same page moves the change on: Marketing or the
// commercial lead schedules the launch of an offer, the commercial lead
// that of a price (a price migration, a prepaid pass); a scheduled launch can
// be cancelled with a reason; the on-call engineer suspends a live offer or
// a pass on sale with a reason. A price migration that started is never
// suspended (§4.2): its page says where its existing subscribers stand.
//
// The page is the same for every kind of change; what it shows as evidence
// follows the kind: a campaign's simulation, a price migration's rules of
// its market (the law apart from the music service's choice, §8.1) and its
// simulation, a prepaid pass's prices, months and periods of sale.
import { formatCount, formatMoney, formatPercent } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { CONSOLE_ZONE, PageBody, PageHead } from "../../components/frame.tsx";
import { Button, ButtonLink, Callout, Chip, ErrorPanel, Loading, Locked, StateChip } from "../../components/ui.tsx";
import {
  ApproveChangeDocument, AuditEventsDocument, type AuditEventsQuery, CancelChangeDocument, ChangeDocument, type ChangeQuery, LaunchRunsDocument, MarketsDocument,
  RejectChangeDocument, ScheduleChangeDocument, SimulateOfferDocument, SuspendChangeDocument,
} from "../../graphql/generated.ts";
import { launchHref, launchLook } from "../../lib/launch.ts";
import { describeChanges } from "../../lib/diff.ts";
import { kindOf, progressHref } from "../../lib/kinds.ts";
import { marketName, marketZone, planName } from "../../lib/markets.ts";
import {
  type ApprovalView, approvesWithoutScheduling, can, conditionSigner, decide, decisionSentence, primaryRole, ROLE_NAME, type Role, sendsBack, signerWords, whoDoes,
} from "../../lib/permissions.ts";
import { useAction, useGatewayQuery, useRefreshChanges } from "../../lib/react/gateway.tsx";
import { recordGuide, useGuideRecord } from "../../lib/react/sandbox.tsx";
import { SANDBOX_MODE } from "../../lib/sandbox.ts";
import { useViewer } from "../../lib/react/session.tsx";
import { formatInstantIn, formatLocalWithUtc } from "../../lib/time.ts";
import { MarketsUnavailable } from "../../components/change-parts.tsx";
import { TableScroll } from "../../components/table-scroll.tsx";
import { ChangeTabs } from "../campaigns/tabs.tsx";
import { MigrationInShort } from "../migration/in-short.tsx";
import { MarketPolicy } from "../migration/policy.tsx";
import { useArtistNames } from "../wizard/artists.tsx";

type Change = NonNullable<ChangeQuery["change"]>;
type Event = AuditEventsQuery["auditEvents"]["nodes"][number];
type Result = { readonly __typename: "Change" } | { readonly __typename: "Refusal"; readonly code: string; readonly reason: string };

const short = (hash: string) => `${hash.slice(0, 4)}…${hash.slice(-4)}`;

export function ApprovalScreen() {
  const id = useSearchParams().get("id") ?? "";
  const valid = /^\d+$/.test(id);
  const change = useGatewayQuery(ChangeDocument, { id }, { enabled: valid });
  const events = useGatewayQuery(AuditEventsDocument, { filter: { subject: `change:${id}` }, first: 100, after: null }, { enabled: valid });
  const markets = useGatewayQuery(MarketsDocument, {}, { staleTime: 5 * 60_000 });
  const data = change.data?.change ?? null;

  const submitted = events.data?.auditEvents.nodes.find((event) => event.action === "change.submitted" && JSON.parse(event.body || "{}").version === data?.currentVersion);
  const head = (
    <PageHead
      crumbs={[{ label: "Approvals", href: "/approvals/" }, { label: data ? `${data.title} v${data.currentVersion}` : `Change #${id}` }]}
      title={data ? <>{data.title} <span className="text-ink-2">v{data.currentVersion}</span></> : "Approval"}
      sub={data ? (
        <>
          <StateChip state={data.state} />
          {submitted ? <span>{roleWord(submitted.actorRole)} submitted it on {formatInstantIn(submitted.at, CONSOLE_ZONE, { year: true })}</span> : <span>Created by {data.createdBy.label}</span>}
        </>
      ) : null}
    />
  );
  if (!valid) return <>{head}<PageBody><Callout tone="error" icon="warning">This address names no change. <Link href="/approvals/">Back to the approvals</Link>.</Callout></PageBody></>;
  if (change.isPending || markets.isPending) return <>{head}<PageBody><Loading what="the change" lines={10} /></PageBody></>;
  if (change.isError) return <>{head}<PageBody><ErrorPanel error={change.error} retry={() => void change.refetch()} /></PageBody></>;
  if (data === null) return <>{head}<PageBody><Callout tone="error" icon="warning">There is no change #{id}. <Link href="/approvals/">Back to the approvals</Link>.</Callout></PageBody></>;
  // Without the markets, no time of this change can be read in its market's zone, nor its launch scheduled.
  const known = markets.data?.markets;
  if (known === undefined) return <>{head}<PageBody><MarketsUnavailable error={markets.error} retry={() => void markets.refetch()} /></PageBody></>;
  return (
    <>
      {head}
      <PageBody className="gap-6">
        <ChangeTabs kind={data.kind} changeId={data.id} current="approval" />
        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:gap-12">
          <div className="order-2 grid min-w-0 content-start gap-8 xl:order-1">
            <Evidence change={data} events={events.data?.auditEvents.nodes ?? []} markets={known} />
          </div>
          <div className="order-1 xl:sticky xl:top-4 xl:order-2">
            <DecisionPanel change={data} markets={known} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

function roleWord(role: string): string {
  if (role === "SYSTEM") return "The activation job";
  if (role === "SUBSCRIBER") return "A subscriber";
  return ROLE_NAME[role as Role] ?? role;
}

function Block({ title, children, id }: { readonly title: string; readonly children: ReactNode; readonly id: string }) {
  return (
    <section className="grid gap-3 border-t-2 border-ink pt-3" aria-labelledby={id}>
      <h2 id={id} className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Evidence({ change, events, markets }: { readonly change: Change; readonly events: readonly Event[]; readonly markets: readonly { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string }[] }) {
  const viewer = useViewer();
  const previous = change.versions.find((version) => version.version === change.currentVersion - 1) ?? null;
  // The artists of a fans' campaign (§14.2), by name for the roles that read the catalog's artists.
  const fansOf = [previous?.content, change.current.content].flatMap((version) =>
    version?.__typename === "OfferContent" && version.audience.listening ? [version.audience.listening.artistId] : []);
  const artistNames = useArtistNames(fansOf);
  const differences = previous ? describeChanges(previous.content, change.current.content, markets, artistNames) : [];
  const sentBack = events.filter((event) => event.action === "change.rejected");
  const lastSentBack = sentBack[0] ?? null;
  const content = change.current.content;
  const offer = content.__typename === "OfferContent" ? content : null;
  const migration = content.__typename === "PriceMigrationContent" ? content : null;
  const pass = content.__typename === "PrepaidPassContent" ? content : null;
  const firstMarket = offer?.prices[0]?.market ?? null;

  return (
    <>
      <Block id="the-change" title="The change">
        {change.sentence ? <p className="sentence">{change.sentence}</p> : <Callout icon="info" tone="quiet">v{change.currentVersion} has not been checked yet: its sentence in business words comes with the check.</Callout>}
      </Block>

      {previous ? (
        <Block id="changed" title={`Changed since v${previous.version}`}>
          {differences.length === 0 ? <p className="text-ink-2">v{change.currentVersion} says the same as v{previous.version}.</p> : (
            <TableScroll labelledBy="changed">
              <table className="data diff min-w-[30rem]">
                <thead><tr><th scope="col">Field</th><th scope="col">v{previous.version}</th><th scope="col">v{change.currentVersion}</th></tr></thead>
                <tbody>
                  {differences.map((difference) => (
                    <tr key={difference.field}>
                      <th scope="row">{difference.field}</th>
                      <td><del>{difference.before}</del></td>
                      <td><ins>{difference.after}</ins></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          {lastSentBack?.reason ? (
            <blockquote className="said m-0">
              <p>{lastSentBack.reason}</p>
              <footer className="text-xs text-ink-2">{roleWord(lastSentBack.actorRole)}, sending v{JSON.parse(lastSentBack.body || "{}").version ?? previous.version} back on {formatInstantIn(lastSentBack.at, CONSOLE_ZONE)}</footer>
            </blockquote>
          ) : null}
        </Block>
      ) : null}

      {migration ? (
        <div className="border-t-2 border-ink pt-3">
          <MarketPolicy market={migration.market} />
        </div>
      ) : null}

      <Block id="who-signs" title="Who has to sign">
        {change.requiredSignatures.length === 0 ? <p className="text-ink-2">Who signs is known once the version is checked.</p> : (
          <ul role="list" className="grid gap-2">
            {change.requiredSignatures.map((signature) => (
              <li key={signature.role} className="flex flex-wrap items-center gap-2">
                {signature.signed ? <Chip look="done" icon="check-circle">Signed</Chip> : <Chip look="waiting" icon="hourglass-medium">Waiting for {signerWords(signature)}</Chip>}
                <span>{signature.why}</span>
              </li>
            ))}
          </ul>
        )}
        {change.approvals.length ? (
          <ul role="list" className="grid gap-1 text-sm">
            {change.approvals.map((approval) => (
              <li key={`${approval.approver.id}-${approval.version}`} className="flex items-baseline gap-2">
                <Icon name="signature" size={15} className="translate-y-0.5 text-indigo" />
                Signed by {approval.approver.label}{approval.approver.label === ROLE_NAME[approval.role] ? "" : ` as ${ROLE_NAME[approval.role]}`}: v{approval.version}, fingerprint {short(approval.fingerprint)}, on {formatInstantIn(approval.decidedAt, CONSOLE_ZONE)}.
              </li>
            ))}
          </ul>
        ) : null}
      </Block>

      {pass ? <PassInShort pass={pass} markets={markets} /> : migration ? (
        <Block id="simulation" title="The simulation, in short">
          {can(viewer.roles, "simulate") ? <MigrationInShort changeId={change.id} version={change.currentVersion} /> : (
            <p className="text-ink-2">{whoDoes("simulate", { one: "runs simulations", many: "run simulations" })}; the conditions that ask for a signature are above, with the reasons the engine gave.</p>
          )}
        </Block>
      ) : firstMarket && can(viewer.roles, "simulate") ? <SimulationInShort change={change} market={firstMarket} marketLabel={marketName(markets, firstMarket)} /> : (
        <Block id="simulation" title="The simulation, in short">
          <p className="text-ink-2">{whoDoes("simulate", { one: "runs simulations", many: "run simulations" })}; the conditions that ask for a signature are above, with the reasons the engine gave.</p>
        </Block>
      )}

      {offer ? (
        <Block id="reason" title="Why it is worth running, in the author's words">
          {change.authorReason ? (
            <blockquote className="said m-0">
              <p>{change.authorReason}</p>
              <footer className="text-xs text-ink-2">{change.current.author.label}, with v{change.currentVersion}</footer>
            </blockquote>
          ) : <p className="text-ink-2">The author gave no reason: none is required when the simulated contribution is not negative (§7.3, condition 4).</p>}
        </Block>
      ) : change.authorReason ? (
        <Block id="reason" title={migration ? "Why the price rises, in the author's words" : "In the author's words"}>
          <blockquote className="said m-0">
            <p>{change.authorReason}</p>
            <footer className="text-xs text-ink-2">{change.current.author.label}, with v{change.currentVersion}</footer>
          </blockquote>
        </Block>
      ) : null}

      <Block id="fingerprint" title="Version and fingerprint">
        <p>An approval names v{change.currentVersion} and the fingerprint of its content (§7.2). Any edit makes v{change.currentVersion + 1}, and approvals don't carry over.</p>
        <p className="code" aria-label={`Fingerprint of v${change.currentVersion}`}>{change.current.fingerprint}</p>
        <TableScroll labelledBy="fingerprint">
          <table className="data min-w-[36rem]">
            <thead><tr><th scope="col">Version</th><th scope="col" className="wrap">Saved by, when</th><th scope="col" className="wrap">What happened to it</th><th scope="col">Fingerprint</th></tr></thead>
            <tbody>
              {[...change.versions].sort((a, b) => b.version - a.version).map((version) => {
                const rejected = sentBack.find((event) => JSON.parse(event.body || "{}").version === version.version);
                return (
                  <tr key={version.version}>
                    <th scope="row">v{version.version}</th>
                    <td className="wrap">{version.author.label}, {formatInstantIn(version.createdAt, CONSOLE_ZONE)}</td>
                    <td className="wrap">
                      {version.version === change.currentVersion ? <StateChip state={change.state} /> : rejected ? <Chip look="rejected" icon="x-circle">Sent back by {roleWord(rejected.actorRole)}</Chip> : <Chip look="ended" icon="circle-dashed">Superseded</Chip>}
                    </td>
                    <td className="font-semibold tracking-[0.02em]">{short(version.fingerprint)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Block>

      <Block id="history" title="In the audit log">
        {events.length === 0 ? <p className="text-ink-2">No event yet.</p> : (
          <ol className="m-0 grid list-none p-0">
            {events.map((event) => (
              <li key={event.seq} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-b border-cord py-2 text-sm">
                <Link href={`/audit/?seq=${event.seq}`} className="font-bold">#{event.seq}</Link>
                <span>
                  <b>{event.action}</b> by {roleWord(event.actorRole)} on {formatInstantIn(event.at, CONSOLE_ZONE, { seconds: true })}
                  {event.reason ? <span className="block text-ink-2">{event.reason}</span> : null}
                  <span className="block text-xs text-ink-2">Request {event.requestId}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Block>
    </>
  );
}

function SimulationInShort({ change, market, marketLabel }: { readonly change: Change; readonly market: string; readonly marketLabel: string }) {
  const result = useGatewayQuery(SimulateOfferDocument, { changeId: change.id, version: change.currentVersion, market, overrides: null }, { staleTime: 60_000 });
  const simulation = result.data?.simulateOffer.__typename === "Simulation" ? result.data.simulateOffer : null;
  return (
    <Block id="simulation" title="The simulation, in short">
      {result.isPending ? <Loading what="the simulation" lines={3} /> : result.isError ? <ErrorPanel error={result.error} retry={() => void result.refetch()} /> : simulation ? (
        <>
          <p className="max-w-[75ch]">
            In {marketLabel}, at the book's assumptions, the campaign {BigInt(simulation.difference.contribution.amountMinor) < 0n ? "loses" : "earns"}{" "}
            {formatMoney({ ...simulation.difference.contribution, amountMinor: simulation.difference.contribution.amountMinor.replace("-", "") })} over {simulation.horizonMonths} months.{" "}
            {simulation.breakEvenRetentionBasisPoints !== null && simulation.breakEvenRetentionBasisPoints >= 0 ? `It breaks even if at least ${formatPercent(simulation.breakEvenRetentionBasisPoints)} of takers stay at the list price. ` : "No retention makes it break even. "}
            Discount and top-up cost {formatMoney({ amountMinor: (BigInt(simulation.discountCost.amountMinor) + BigInt(simulation.topUpCost.amountMinor)).toString(), currency: simulation.discountCost.currency })}.{" "}
            {formatCount(simulation.takers)} of {formatCount(simulation.eligible)} eligible people take it at the assumed take-up.
          </p>
          <ol className="m-0 grid list-none p-0">
            {simulation.financeConditions.map((condition) => (
              <li key={condition.number} className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-2 border-b border-cord py-2 ${condition.met ? "" : "text-ink-2"}`}>
                <span className="font-bold text-ink-2">{condition.number}</span>
                <span className={condition.met ? "font-semibold" : ""}>{condition.rule}<small className="block text-xs font-normal text-ink-2">{condition.detail}</small></span>
                <span className="inline-flex items-center gap-1 text-xs font-bold whitespace-nowrap">{condition.met ? <><Icon name="check" size={13} />Met</> : "Not met"}</span>
              </li>
            ))}
          </ol>
          <p><Link href={`/campaigns/simulation/?id=${change.id}&market=${market}`} className="inline-flex items-center gap-1.5 font-semibold pointer-coarse:-my-3 pointer-coarse:py-3"><Icon name="calculator" size={16} />Open the simulation</Link></p>
        </>
      ) : result.data?.simulateOffer.__typename === "Refusal" ? <p className="text-ink-2">{result.data.simulateOffer.reason}</p> : null}
    </Block>
  );
}

type PassContentView = Extract<Change["current"]["content"], { readonly __typename: "PrepaidPassContent" }>;

/** A prepaid pass in short: in each market, its price paid once, the months it gives, when it is on sale, how long a code waits. */
function PassInShort({ pass, markets }: { readonly pass: PassContentView; readonly markets: readonly { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string }[] }) {
  return (
    <Block id="pass" title="The pass, in short">
      <p className="max-w-[75ch]">
        {planName(pass.plan)} for {pass.months} month{pass.months === 1 ? "" : "s"}, paid once and never renewed; a code sold waits up to {pass.codeValidMonths} months to be activated, then expires, unused. Price changes made after a sale never touch it (§9.1).
      </p>
      <TableScroll labelledBy="pass">
        <table className="data min-w-[30rem]">
          <thead><tr><th scope="col">Market</th><th scope="col">Price, paid once</th><th scope="col" className="wrap">On sale</th></tr></thead>
          <tbody>
            {pass.prices.map((price) => {
              const period = pass.periods.find((entry) => entry.market === price.market);
              const zone = marketZone(markets, price.market);
              return (
                <tr key={price.market}>
                  <th scope="row">{marketName(markets, price.market)}</th>
                  <td className="font-bold">{formatMoney(price.amount)}</td>
                  <td className="wrap">{period ? `${formatLocalWithUtc(period.startsLocal, zone)}${period.endsLocal ? ` until ${formatLocalWithUtc(period.endsLocal, zone)}` : ", no end announced"}` : "not set"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Block>
  );
}

/** The launches of a change, newest first: where its activation stands, and the way to its timeline; with a title, a section of its own, shown only when there is a launch. */
export function ItsLaunches({ changeId, title }: { readonly changeId: string; readonly title?: string }) {
  const launches = useGatewayQuery(LaunchRunsDocument, { filter: { changeId }, first: 5, after: null });
  const runs = launches.data?.launches.nodes ?? [];
  if (runs.length === 0) return null;
  const list = (
    <ul role="list" className="grid gap-1.5">
      {runs.map((run) => {
        const look = launchLook(run);
        return (
          <li key={run.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Icon name="rocket-launch" size={16} className="text-indigo" />
            <Link href={launchHref(run.id)} className="font-semibold pointer-coarse:-my-3 pointer-coarse:py-3">Its launch, {run.run}</Link>
            <Chip look={look.look} icon={look.icon}>{look.word}</Chip>
          </li>
        );
      })}
    </ul>
  );
  if (title === undefined) return list;
  return (
    <section className="grid gap-2 border-t border-cord pt-3" aria-labelledby={`launches-of-${changeId}`}>
      <h2 id={`launches-of-${changeId}`} className="text-base font-bold">{title}</h2>
      {list}
    </section>
  );
}

function DecisionPanel({ change, markets }: { readonly change: Change; readonly markets: readonly { readonly code: string; readonly name: string; readonly timeZone: string; readonly currency: string }[] }) {
  const viewer = useViewer();
  const refresh = useRefreshChanges();
  const role = primaryRole(viewer.roles);
  const headingId = useId();
  const approveButton = useRef<HTMLButtonElement>(null);
  const sendBackButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<"approve" | "reject" | "schedule" | "cancel" | "suspend" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonOpen, setReasonOpen] = useState<"reject" | "cancel" | "suspend" | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [done, setDone] = useState<{ readonly words: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const view: ApprovalView = {
    state: change.state,
    version: change.currentVersion,
    versions: change.versions.map((version) => ({ version: version.version, authorId: version.author.id })),
    signatures: change.requiredSignatures,
    approvals: change.approvals.map((approval) => ({ version: approval.version, approverId: approval.approver.id })),
  };
  const decision = decide(view, viewer);
  // In the demo, "Try this" ticks when the author of its campaign finds no button here (lib/guide.ts).
  const guide = useGuideRecord();
  const triedOwn = SANDBOX_MODE && decision.kind === "author" && guide.changeId === change.id && !guide.triedOwn;
  useEffect(() => {
    if (triedOwn) recordGuide({ triedOwn: true });
  }, [triedOwn]);
  // Sending back has its own rule: a role that reviews, not an author (lib/permissions.ts).
  const backable = sendsBack(view, viewer);
  const fingerprint = change.current.fingerprint;
  const content = change.current.content;
  const offer = content.__typename === "OfferContent" ? content : null;
  const migration = content.__typename === "PriceMigrationContent" ? content : null;
  const pass = content.__typename === "PrepaidPassContent" ? content : null;
  const kind = kindOf(change.kind);
  const firstStart = offer?.periods[0] ?? pass?.periods[0] ?? null;
  const startWords = migration
    ? `${marketName(markets, migration.market)}: ${formatLocalWithUtc(migration.noticesLocal, marketZone(markets, migration.market))}, when the existing subscribers are asked or told; new subscribers pay it from ${formatLocalWithUtc(migration.startsLocal, marketZone(markets, migration.market))}`
    : firstStart ? `${marketName(markets, firstStart.market)}: ${formatLocalWithUtc(firstStart.startsLocal, marketZone(markets, firstStart.market))}` : "its start date";
  const schedules = kind.schedules;
  const cancels = kind.cancels;
  // The engine suspends a live offer or a pass on sale; a list price or a price migration in force is never edited (§4.2).
  const suspendable = change.kind === "OFFER" || change.kind === "PREPAID";
  const again = change.kind === "PRICE_MIGRATION"
    ? whoDoes("createPriceMigration", { one: "writes a new price migration", many: "write a new price migration" }, { start: false, either: true })
    : change.kind === "PREPAID"
      ? whoDoes("createPrepaidPass", { one: "writes a new pass", many: "write a new pass" }, { start: false, either: true })
      : whoDoes("createOffer", { one: "starts a new campaign", many: "start a new campaign" }, { start: false, either: true });

  const after = async (result: Result, words: string) => {
    if (result.__typename === "Refusal") {
      setRefusal(`${result.reason} (${result.code.toLowerCase().replaceAll("_", " ")})`);
    } else {
      setDone({ words });
      setReason("");
      setReasonOpen(null);
    }
    setConfirming(null);
    await refresh();
  };
  const approve = useAction(ApproveChangeDocument, "approve-change");
  const reject = useAction(RejectChangeDocument, "reject-change");
  const schedule = useAction(ScheduleChangeDocument, "schedule-change");
  const cancel = useAction(CancelChangeDocument, "cancel-change");
  const suspend = useAction(SuspendChangeDocument, "suspend-change");
  const failure = approve.error ?? reject.error ?? schedule.error ?? cancel.error ?? suspend.error;
  const busy = approve.isPending || reject.isPending || schedule.isPending || cancel.isPending || suspend.isPending;

  const askReason = (kind: "reject" | "cancel" | "suspend") => {
    if (reason.trim().length < 3) {
      setReasonError("Write the reason: it goes to the author and into the audit log.");
      document.getElementById("decision-reason")?.focus();
      return;
    }
    setReasonError(null);
    setConfirming(kind);
  };

  return (
    <section className="grid gap-4 border border-ink bg-stone-0 px-5 pt-4 pb-5" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-3xl font-bold">Decision</h2>
      <p className="text-xs text-ink-2">Demo role: <b className="text-ink">{role ? ROLE_NAME[role] : "none"}</b>. Change it in the menu to see what another role can do.</p>
      {done ? <Callout tone="good" icon="check-circle" role="status">{done.words}</Callout> : null}
      {refusal ? <Callout tone="error" icon="warning" role="alert"><p className="font-bold">The engine refused it.</p><p>{refusal}</p></Callout> : null}
      {failure ? <ErrorPanel error={failure} /> : null}

      {change.state === "IN_APPROVAL" ? (
        <>
          {decision.kind === "sign" ? (
            <p>This approval names v{change.currentVersion} (fingerprint {short(fingerprint)}). Any edit makes v{change.currentVersion + 1}, and approvals don't carry over.</p>
          ) : (
            <Locked>{decisionSentence(decision, role)}</Locked>
          )}
          {decision.kind !== "sign" && backable ? <p>You can still send v{change.currentVersion} back to its author, with a reason.</p> : null}
          {decision.kind === "sign" || backable ? (
            <div className="flex flex-wrap gap-3">
              {decision.kind === "sign" ? (
                <Button ref={approveButton} weight="primary" size="big" icon="signature" busy={approve.isPending} onClick={() => setConfirming("approve")}>
                  Approve v{change.currentVersion} as {ROLE_NAME[decision.as]}
                </Button>
              ) : null}
              {backable ? (
                <Button ref={sendBackButton} icon="arrow-u-up-left" onClick={() => setReasonOpen(reasonOpen === "reject" ? null : "reject")} aria-expanded={reasonOpen === "reject"} aria-controls="decision-reason-form">
                  Send back with a reason
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {change.state === "APPROVED" ? (
        schedules && can(viewer.roles, schedules) ? (
          <>
            <p>Approved. It starts only once it is scheduled: {startWords}.</p>
            <Button weight="primary" icon="calendar-check" busy={schedule.isPending} onClick={() => setConfirming("schedule")} className="justify-self-start">Schedule the launch</Button>
          </>
        ) : schedules ? <Locked>Approved. {whoDoes(schedules, { one: "schedules the launch", many: "schedule the launch" })}; {approvesWithoutScheduling({ start: false, schedules })}.</Locked> : <Locked>Approved.</Locked>
      ) : null}

      {["SCHEDULED", "ACTIVE", "SUSPENDED", "CANCELLED", "ENDED"].includes(change.state) ? <ItsLaunches changeId={change.id} /> : null}

      {change.state === "SCHEDULED" ? (
        <>
          <p>Scheduled: {startWords}. The engine begins its launch a minute before, runs it step by step, and publishes the catalog with it in one transaction (§7.5).</p>
          {cancels && can(viewer.roles, cancels) ? (
            <Button icon="x-circle" onClick={() => setReasonOpen(reasonOpen === "cancel" ? null : "cancel")} aria-expanded={reasonOpen === "cancel"} aria-controls="decision-reason-form" className="justify-self-start">Cancel the launch</Button>
          ) : cancels ? <Locked>{whoDoes(cancels, { one: "can cancel a scheduled launch", many: "can cancel a scheduled launch" })}.</Locked> : null}
        </>
      ) : null}

      {change.state === "ACTIVE" && migration ? (
        <>
          <p>Started: the existing subscribers were {change.migration?.requirement === "NOTICE" ? "told" : "asked"}, and new subscribers pay the new price from its start.</p>
          {change.migration ? <p className="text-sm">{change.migration.asked.toLocaleString("en-GB")} asked or told; {change.migration.waiting.toLocaleString("en-GB")} waiting, {change.migration.accepted.toLocaleString("en-GB")} accepted, {change.migration.declined.toLocaleString("en-GB")} declined, {change.migration.lapsed.toLocaleString("en-GB")} lapsed.</p> : null}
          <ButtonLink href={progressHref(change.id)} size="small" icon="users" className="justify-self-start">See the progress</ButtonLink>
          <p className="text-xs text-ink-2">A price migration in force is not suspended: its price is in the price list, which is never edited (§4.2), and the subscribers were asked or told already. To go back for new subscribers, {whoDoes("createListPrice", { one: "creates a new list price", many: "create a new list price" }, { start: false })} and {conditionSigner()} signs it.</p>
        </>
      ) : change.state === "ACTIVE" ? (
        <>
          <p>{pass ? "On sale on the site." : "Live on the site."}</p>
          {suspendable && can(viewer.roles, "suspend") ? (
            <Button icon="pause" onClick={() => setReasonOpen(reasonOpen === "suspend" ? null : "suspend")} aria-expanded={reasonOpen === "suspend"} aria-controls="decision-reason-form" className="justify-self-start">Suspend it</Button>
          ) : suspendable ? <Locked>{whoDoes("suspend", { one: pass ? "takes a pass off sale" : "suspends a live offer", many: pass ? "take a pass off sale" : "suspend a live offer" })}, with a reason.</Locked> : null}
        </>
      ) : null}

      {change.state === "DRAFT" || change.state === "VALIDATED" ? (
        <Locked>{change.state === "DRAFT" ? "A draft" : "Checked, not submitted"}: nothing to approve yet. {change.stateReason ? `Sent back: ${change.stateReason}` : ""}</Locked>
      ) : null}
      {["ENDED", "CANCELLED", "SUSPENDED"].includes(change.state) ? <Locked>{change.state === "ENDED" ? "Ended." : change.state === "CANCELLED" ? "Cancelled" : "Suspended"}{change.stateReason ? `: ${change.stateReason}` : "."}</Locked> : null}

      {reasonOpen ? (
        <form id="decision-reason-form" className="grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          askReason(reasonOpen);
        }}>
          <label htmlFor="decision-reason" className="label">{reasonOpen === "reject" ? `Why v${change.currentVersion} goes back to its author` : reasonOpen === "cancel" ? "Why the launch is cancelled" : "Why the offer is suspended"}</label>
          <textarea id="decision-reason" className="input" rows={4} value={reason} onChange={(event) => setReason(event.target.value)} aria-invalid={reasonError ? true : undefined} aria-describedby={reasonError ? "decision-reason-error" : undefined} />
          {reasonError ? <p className="field-error" id="decision-reason-error"><Icon name="warning-circle" size={16} />{reasonError}</p> : null}
          <Button type="submit" icon={reasonOpen === "reject" ? "arrow-u-up-left" : reasonOpen === "cancel" ? "x-circle" : "pause"} className="justify-self-start">
            {reasonOpen === "reject" ? `Send v${change.currentVersion} back` : reasonOpen === "cancel" ? "Cancel the launch" : "Suspend it"}
          </Button>
        </form>
      ) : null}

      {change.state === "IN_APPROVAL" && decision.kind === "sign" ? (
        <p className="text-xs text-ink-2">The engine checks the version and the fingerprint again, and that you did not write it; the database refuses an approval by the author a third time (§7.4).</p>
      ) : null}

      <ConfirmDialog
        open={confirming === "approve"}
        title={`Approve v${change.currentVersion} as ${decision.kind === "sign" ? ROLE_NAME[decision.as] : ""}?`}
        confirmLabel={`Approve v${change.currentVersion}`}
        confirmIcon="signature"
        busy={approve.isPending}
        onCancel={() => setConfirming(null)}
        returnFocus={approveButton}
        onConfirm={async () => {
          const result = (await approve.mutateAsync({ changeId: change.id, version: change.currentVersion, fingerprint }).catch(() => null))?.approveChange as Result | undefined;
          if (result) await after(result, `Approved v${change.currentVersion}${decision.kind === "sign" ? ` as ${ROLE_NAME[decision.as]}` : ""}. The audit log has it, with this request's id.`);
          else setConfirming(null);
        }}
      >
        <p>This approval names v{change.currentVersion} and its fingerprint:</p>
        <p className="code">{fingerprint}</p>
        <Callout icon="warning"><b>This can't be undone.</b> Any edit afterwards makes v{change.currentVersion + 1}, which needs its own approval. Once every signature is there, {whoDoes(schedules ?? "scheduleOffer", { one: "schedules it", many: "schedule it" }, { start: false, either: true })}.</Callout>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "reject"}
        title={`Send v${change.currentVersion} back to its author?`}
        confirmLabel={`Send v${change.currentVersion} back`}
        confirmIcon="arrow-u-up-left"
        busy={reject.isPending}
        onCancel={() => setConfirming(null)}
        returnFocus={sendBackButton}
        onConfirm={async () => {
          const result = (await reject.mutateAsync({ changeId: change.id, version: change.currentVersion, reason: reason.trim() }).catch(() => null))?.rejectChange as Result | undefined;
          if (result) await after(result, `Sent v${change.currentVersion} back to draft, with your reason.`);
          else setConfirming(null);
        }}
      >
        <p>v{change.currentVersion} (fingerprint {short(fingerprint)}) goes back to draft with this reason:</p>
        <blockquote className="said m-0"><p>{reason.trim()}</p></blockquote>
        <Callout icon="warning"><b>This can't be undone.</b> The author edits it into v{change.currentVersion + 1}, which needs a new approval.</Callout>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "schedule"}
        title={`Schedule the launch of v${change.currentVersion}?`}
        confirmLabel="Schedule the launch"
        confirmIcon="calendar-check"
        busy={schedule.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          const result = (await schedule.mutateAsync({ changeId: change.id }).catch(() => null))?.scheduleChange as Result | undefined;
          if (result) await after(result, `Scheduled. It starts at ${startWords}.`);
          else setConfirming(null);
        }}
      >
        <p>The engine activates v{change.currentVersion} (fingerprint {short(fingerprint)}) at {startWords}{migration ? "." : ", and the site shows it from then."}</p>
        <Callout icon="info">Until then it can still be cancelled, with a reason.</Callout>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "cancel" || confirming === "suspend"}
        title={confirming === "cancel" ? "Cancel the launch?" : pass ? "Take the pass off sale?" : "Suspend the live offer?"}
        confirmLabel={confirming === "cancel" ? "Cancel the launch" : "Suspend it"}
        confirmIcon={confirming === "cancel" ? "x-circle" : "pause"}
        busy={cancel.isPending || suspend.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          const result = confirming === "cancel"
            ? (await cancel.mutateAsync({ changeId: change.id, reason: reason.trim() }).catch(() => null))?.cancelChange as Result | undefined
            : (await suspend.mutateAsync({ changeId: change.id, reason: reason.trim() }).catch(() => null))?.suspendChange as Result | undefined;
          if (result) await after(result, confirming === "cancel" ? "Cancelled: it will not start." : pass ? "Suspended: the pass is off sale." : "Suspended: the site no longer shows it.");
          else setConfirming(null);
        }}
      >
        <p>{change.title} v{change.currentVersion}, with this reason:</p>
        <blockquote className="said m-0"><p>{reason.trim()}</p></blockquote>
        <Callout icon="warning"><b>This can't be undone.</b> To {change.kind === "PRICE_MIGRATION" ? "raise the price later" : change.kind === "PREPAID" ? "sell it again" : "offer it again"}, {again}.</Callout>
      </ConfirmDialog>
      {busy ? <span className="sr-only" role="status">Sending</span> : null}
      <ButtonLink href="/approvals/" size="small" weight="quiet" icon="arrow-left" className="justify-self-start">All approvals</ButtonLink>
    </section>
  );
}
