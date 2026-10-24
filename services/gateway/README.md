# Gateway

The GraphQL layer between the two web applications and the commerce engine.
The console (the internal tool where people create, approve and launch
changes) and the site (where customers see plans and offers) never talk to
the engine directly: they talk to the gateway, and the gateway calls the
engine over gRPC with the contract in `proto/`.

It serves two schemas, each on its own port, so the site's port cannot reach
the console's schema at all:

| | Schema | Port | For |
|---|---|---|---|
| Console's API | `schema/internal.graphql` | 4621 | changes, approvals, simulations, price migrations, prepaid passes, launches, the audit log, the home's numbers |
| Site's API | `schema/public.graphql` | 4622 | markets, plans, list prices, offers and prepaid passes on sale, quotes; the demo's listeners, a student verification, a subscription, the account, its price changes and the answer to them, a prepaid pass bought and its code activated |

Both answer at `/graphql`, with `/health` next to it.

## Sign-in is a demonstration, not authentication

The console's API has one sign-in mode: `signIn(personId)` picks one of the
demo's people, as the engine lists them, and the gateway keeps who they are
in a session cookie. Anyone who can reach the port can be anyone on that
list. This is on purpose, for a sandbox, and the gateway says so in its log
at every start.

What is real behind it:

- the browser never sends a role. The session holds the person; their roles
  come from the engine's list at sign-in;
- every operation is authorized on the server, from the session, with the
  role matrix of the business book's §12 (`src/core/roles.ts`, the same
  matrix the engine applies again as the trusted layer);
- the engine checks the person and the role once more on every call, and
  the database enforces separation of duties a third time.

The site's API has the same kind of sign-in for its visitors:
`signInAsListener(listenerId)` picks one of the demo's listeners (invented
people with simulated data, as the engine lists them, each labelled with
what it shows), and the gateway keeps which one in a session of the site's
own. From then on the session says who the site acts for: no argument of the
site's schema names a subscriber, and the gateway writes the session's
listener into every call of the engine's subscriber service itself, over
whatever a request might carry (`src/core/engine.ts`). Only the demo's
listeners can be chosen, never another subscriber.

The gateway refuses to start in any other mode (`GATEWAY_AUTH` accepts
`demo` only), and refuses to serve the console's API in production
(`GATEWAY_ENV=production` or `NODE_ENV=production`), because there the
browser must never choose its own privileges. In production it can serve the
site's API alone (`GATEWAY_ENDPOINTS=public`), and that API keeps no
sessions: the entrance lists nobody, `signInAsListener` answers `FORBIDDEN`,
and only the catalog and anonymous quotes remain.

A real deployment needs OpenID Connect: an identity provider that signs ID
tokens; the gateway verifying issuer, audience, expiry and signature; roles
taken from the provider's claims or a server-side directory, never from the
browser; and sessions bound to the verified identity, the site's listeners'
as well. None of that exists here.

## Running it

```
npm run gateway
```

It listens on 127.0.0.1:4621 and 127.0.0.1:4622 and calls the engine at
`ENGINE_URL` (`http://127.0.0.1:4611` by default). It starts without the
engine: `/health` then answers 503 with `"engine": "UNREACHABLE"`, and every
operation that needs the engine answers `ENGINE_UNAVAILABLE` until the engine
is up. Before listening it asks the system whether the ports are taken.

Settings come from the environment. An unknown `GATEWAY_` variable stops the
start, so a misspelt setting never passes for a default.

| Variable | Default | |
|---|---|---|
| `ENGINE_URL` | `http://127.0.0.1:4611` | the engine |
| `COMMERCE_INTERNAL_TOKEN` | `.data/internal-token` in development | secret shared with the engine |
| `GATEWAY_SESSION_SECRET` | `.data/gateway-session-secret` in development | secret that signs both APIs' session cookies, 64 hex digits or more |
| `GATEWAY_ENV` | `development` | `production` turns introspection off, the console's API away and the site's sessions off |
| `GATEWAY_AUTH` | `demo` | the only mode there is |
| `GATEWAY_HOST` | `127.0.0.1` | |
| `GATEWAY_INTERNAL_PORT`, `GATEWAY_PUBLIC_PORT` | 4621, 4622 | |
| `GATEWAY_ENDPOINTS` | `internal,public` | |
| `GATEWAY_CONSOLE_ORIGINS`, `GATEWAY_SITE_ORIGINS` | none | browser origins allowed by CORS, comma separated |
| `GATEWAY_COOKIE_SECURE` | `false` | `true` behind HTTPS |
| `GATEWAY_TRUST_PROXY` | `false` | `true` to read the client address from `X-Forwarded-For` |
| `GATEWAY_RATE_PER_ADDRESS` | `300/60` | requests per seconds, per client address |
| `GATEWAY_RATE_PER_SESSION` | `120/60` | requests per seconds, per session |
| `GATEWAY_ENGINE_READ_TIMEOUT_MS`, `GATEWAY_ENGINE_WRITE_TIMEOUT_MS` | 5000, 10000 | deadline of each engine call |

The two secrets are never written in the code or the log. In development,
when they are not set, each lives in a file in `.data/` (ignored by git),
created once with 32 random bytes by whoever starts first, the engine or the
gateway; the second one reads it. In production the engine's token must be
set; the session key is not needed there, because neither the console's API
nor the site's sessions run in production.

With no origin configured, no browser page on another origin can call
either API. The console and the site of stages 4 and 5 will set theirs.

## Schemas first, types generated

The two schemas are written by hand in `schema/`. `npm run graphql`
generates from them, with GraphQL Code Generator, the TypeScript types of
both schemas and of their resolvers, and the schemas' text as a module (the
core does not read files: in stage 8 it runs in a browser). The resolvers'
parents are the engine's own messages (`src/core/models.ts`), and every field
has a resolver written against them: a field left to a default resolver
would be a field nobody checked. `npm run graphql -- --check` fails when the
generated files differ from a fresh generation.

## What the site's schema shows

Plans and their entitlements, list prices, offers on sale, quotes, and where
each price goes; and, since stage 5, the subscriber's side: the demo's
listeners (`demoListeners`), the session's listener and their account
(`me { account }`: plan, price, the offer's months left, the day the list
price applies from, the next charge, the first month's payment, the student
verification and its end), `verifyStudent`, and
`confirmSubscription(quoteId)`, which subscribes at exactly the quoted price.

Since stage 7, a listener's price changes (§8, §14.3):
`me { account { priceChanges } }` lists them, the latest first, and
`answerPriceChange(priceChangeId, accept)` answers one. In a consent market
(Germany) nothing changes without a yes and silence is no; in a notice
market (Italy, France, the United Kingdom) the new price applies unless the
listener leaves before it, and a yes only says they read it. Every date is
the engine's, worked out on the listener's own billing days, so that the
site writes "your Family plan ends on 15 January 2027" without computing
anything: while a request waits, `appliesFrom` (the first charge at the new
price after a yes today, or when the notice runs out) and `ifNoLeavesOn`
(the day the paid plan ends without a yes, or after a no to a notice); once
decided, `newPriceFrom` or `leavesOn`. `Subscription.endsOn` is the day the
paid subscription ends if the listener does nothing more, and its next
charge is empty when it ends first. The market's law and the music service's
choice come in two fields (`legalBasis`, with its sources, and
`ifNoAnswer`, which says it is a choice and not law): the words the engine
writes for the listener, as an offer's terms are. The same answer again comes
back the same; another answer, or one after the window, is refused as
`ANSWER_CLOSED` with the gateway's sentence; another listener's price change
is not found.

Where a price goes is public by the coordinator's decision of 24 October,
because it is the promise of §1.2: each market's VAT rate and the artists'
guaranteed minimum (`Market.vatBasisPoints`, `Market.artistsMinimum`), and
the breakdown of a plan's list price and of an offer's price (`breakdown`:
price, VAT, net, the artists' share, the top-up the music service adds to
reach the minimum, payment costs, what the service keeps). For the Student
Autumn Pass in Italy that reads: of the artists' €3.00, €1.47 comes from the
subscriber and €1.53 from the service (§14.1). The engine of stage 5 sends no
breakdown with its offers, and the site gets `null` there.

Since stage 7, the prepaid passes (§9, §14.4): months of a plan paid once,
sold as a single-use code to keep or to give. `prepaidPasses(market)` lists
those on sale now, for anyone. `buyPrepaidPass(passId)` buys one for the
session's listener, a demonstration with the simulated provider: the site
names the pass, never its price, which the engine takes from the pass on
sale in the listener's market. The answer is a `PrepaidPurchase` whose
`prepaidCode` is `PENDING` with its payment, and `READY` once the provider
settled it (`me { account { prepaidCodes } }`, the latest first).
`activatePrepaidPass(code)` activates a code for the session's listener,
who may have bought it or been given it: the pass's plan from that day for
its months, at a price of zero, with no next charge and `endsOn` at the end
of its months, then the free plan; `Subscription.prepaidCode` and
`prepaidPrice` say which pass it is. The same code activated again by the
same listener comes back the same. The buyer reads the day a code was
activated, never who activated it.

Nothing else of the economics: no floors, thresholds or simulations, no
breakdown of a quote, no top-ups of the price list; no changes, versions or
approvals, no price migration, its progress or the market's policy as the
console reads it, no value of prepaid passes not yet earned, no people, no
audit log, no ids of subscriptions, payments, migrations, the listener who
activated a code or the verifier's records, and none of the payment
provider's own words. Three tests
check it, each from another angle (`test/public-contract.test.ts`):

1. the whole surface of the schema (types, fields, arguments, enum values,
   union members) equals a list written in the test, in both directions, with
   the reason for each field made public by decision;
2. no name in it belongs to the internal vocabulary (with exceptions, each
   named in the test where it stands, with its reason: a visitor may be told
   `NOT_ELIGIBLE`, signs in and out as a listener, sends back their session's
   `csrfToken`, reads their payment's `state`, reads where a price goes,
   answers a price change of their own, with its `state`, and activates a
   prepaid code, which holds the letters of VAT without being any);
3. an engine that plants marked values in every internal field of its
   messages, the subscriber's included, answers every public field, signed in
   as a listener who verifies, subscribes and pays, as one asked to accept
   a higher price who says yes, and as one who buys a prepaid pass and gives
   its code to another, who activates it; none of the marks comes out.

The payment is asynchronous, as the engine of stage 6 makes it: the
subscription starts at the confirmation, and its first month's `payment`
comes back `PENDING`, asked of the payment provider after the confirmation
commits. The provider's answer settles it, usually within a second: the site
reads `me { account { payment { state receipt } } }` again until it is
`SUCCEEDED`, with a receipt that says no money moved, or `FAILED`, and the
paid subscription then ends with that day. An engine that still charges at
the confirmation (the engine of stage 5) sends the receipt alone: the gateway
reads it as a payment that succeeded at the confirmation, and that engine's
account has no payment to show. The fake engine answers both ways.

No argument or input of the site's schema can carry money: the price is
always the engine's (§4.5).

A refusal on the site is `Refusal { code reason }`, with the site's codes:
`OFFER_ENDED` (asking for a quote of an offer no longer on sale),
`QUOTE_EXPIRED`, `NOT_ELIGIBLE`, `ALREADY_SUBSCRIBED`, `NOT_COMBINABLE`,
`CAP_REACHED`, `PAYMENT_DECLINED` (a charge declined at the confirmation, by
an engine that still charges there), `ANSWER_CLOSED` (a price change answered
already, or whose window ended), `CODE_NOT_USABLE` (a prepaid code whose
payment has not gone through, that was used, or that expired), and
`NOT_AVAILABLE` for any other. A pass not sold in the buyer's market, or a
code of another market, is `NOT_ELIGIBLE`; a listener already paying who
activates a code, `ALREADY_SUBSCRIBED`.
Every reason is a sentence of the gateway's, never the engine's: the engine
writes for the console, naming listeners and offers by their numbers
("Subscriber #5003 is not among..."), and groups and caps the site does not
show. A `NOT_ELIGIBLE` reason says who the offer is for, in the words of its
page ("It is for: verified students in Italy who have never had a paid
plan."), or that a student verification is missing, or that the offer is not
sold in the listener's market. In the tests every answer of the site's API
goes through a guard that fails on a number written with `#`, the word
`Subscriber` or an identifier of the audit log (`INTERNAL_IN_PUBLIC` in
`test/support/harness.ts`).

## Answers and errors

A business refusal is an answer. Every mutation that reaches the engine
returns a union of its result and a `Refusal` with its code
(`OWN_VERSION`, `STALE_VERSION`, `ROLE_NOT_ALLOWED` and the others of the
contract), its reason and its facts. A refusal about a change carries the
change as it is now: with `STALE_VERSION`, the newer version (§6.3).

Errors carry `extensions.code`:

| Code | When |
|---|---|
| `UNAUTHENTICATED` | no session, or it ended; on the site, no listener chosen for what acts for one |
| `FORBIDDEN` | the session's roles may not read this; a wrong CSRF token; a refused origin |
| `NOT_FOUND` | no such change, offer or plan |
| `BAD_USER_INPUT` | malformed arguments, scalars or headers; the engine refused the request as malformed |
| `ENGINE_UNAVAILABLE` | the engine did not answer in time, could not be reached, or refused the gateway's token |
| `INTERNAL_SERVER_ERROR` | anything else, with a generic message |

The console gets the engine's own sentence for malformed, not found and not
allowed; the site gets the gateway's fixed sentences. Nobody gets a stack
trace. Every response has the request id, and the log has the rest under it.

When the gateway itself refuses a role (it applies the matrix before calling
the engine), it answers the way the engine would: a `ROLE_NOT_ALLOWED`
refusal on operations that have an outcome, `FORBIDDEN` on reads. The revenue
fields of the home (`monthlyRevenue`, `monthlyRevenueEur`, `monthlyTopUps`)
are for finance and the commercial lead only, and the value of prepaid passes
sold and not yet earned (`prepaid`, `prepaidUnearnedEur`) for finance alone
(§9.2, §12.2); the other roles get `FORBIDDEN` on those fields and the rest
of the home.

## Launches

Since stage 6 the engine activates a scheduled change through a launch: a
job of five steps (check, prepare, publish, notify, verify), each in a
transaction of its own, begun a minute before the start and resumed where it
stopped after a fault. The console's schema reads them and acts on them:

- `launches(filter: { state, changeId }, first, after)`: newest first, by
  keyset on the launch's id (the cursor is the engine's, opaque here);
- `launch(id)`: one launch with its steps (state, attempts, times, error,
  facts), its cause, the live catalog snapshot before and after it
  published, its resolution, the sequence numbers of the audit events it
  wrote (`auditEventSeqs`, which `auditEvents` finds) and its incidents. A
  page of launches carries no steps and no audit events;
- `retryLaunch(launchId, reason)` and `cancelLaunch(launchId, reason)`: the
  on-call engineer's alone (§12: "retry or cancel a launch that stopped"),
  with an Idempotency-Key; cancelling needs a reason, and a launch that has
  not published (its change is cancelled with it). Every other role gets a
  `ROLE_NOT_ALLOWED` refusal before the engine hears anything.

## Price migrations

Since stage 7 the console writes a third kind of change, the price
migration (§8, §14.3): a higher list price for new subscribers from
`startsLocal`, and for those already paying, from `noticesLocal`, the rules of
their market. The schema has:

- `createPriceMigration(migration)` and `savePriceMigrationVersion(changeId,
  baseVersion, migration)`: the title, plan, market, new price and the two
  local times, for the commercial lead alone; then `validateChange`,
  `submitChange`, `scheduleChange` and `cancelChange` as for any change. The
  commercial lead moves it on and schedules it, finance signs it (conditions
  1 and 5 of §7.3), and the commercial lead or the on-call engineer cancels
  it. The engine's validation blocks a price that does not rise above the
  list price in force (`price`), dates that are not to come or out of order
  (`dates`), and another change of the same plan's price in the same market
  (`overlap`);
- `simulateMigration(changeId, version, overrides)`: the numbers of §8.7,
  for marketing, the commercial lead and finance. Per subscription per month
  before and after (price, net, the artists' share, payment costs,
  contribution), who pays the new price and from when, how many accept at the
  declared acceptance rate, the revenue at risk, the acceptance at which
  revenue and contribution break even, and the prepaid passes it never
  touches. Its assumptions say where they come from: the subscribers
  `EXISTING`, counted in the data, and the `ACCEPTANCE`, the book's
  illustrative default, either of them typed instead. For the Family plan in
  Germany, from €18.99 to €20.99: the net from €15.96 to €17.64, the artists'
  share from €9.58 to €10.58;
- `Market.priceChangePolicy`: the market's law (`law`: consent or notice,
  its basis and its sources) and the music service's choice (`choice`: how
  many days, what happens after the window, in words, the alternatives, and
  the label that says it is a choice and not law), in two types, never
  mixed;
- `Change.migration`: where a migration that started stands: the
  subscribers asked or told, waiting, accepted, declined, lapsed (silence in
  a consent market), paying the new price, and gone to the free plan or
  ended.

## Prepaid passes

Since stage 7 the console writes a fourth kind of change, the prepaid pass
(§9, §14.4): `createPrepaidPass(pass)` and `savePrepaidPassVersion(changeId,
baseVersion, pass)`, with its plan and months, a fixed price in each market
(the input cannot write a percentage), its periods on sale, how many months
a code sold can be activated, and its pages. It goes as a list price does:
the commercial lead writes it and schedules it, finance signs it for
condition 1 of §7.3, and its launch puts it on sale. The home gives finance
alone, by market, the codes paid for, activated and expired unused, and the
value not yet earned (`Overview.prepaid`, and `prepaidUnearnedEur` in all):
a pass's net amount is earned in equal monthly parts from its activation,
the last taking the remainder, so an Italian pass, net €24.58, is earned as
€8.19, €8.19 and €8.20; a code not used stays unearned until it expires.

Every role reads the launches. The home's incidents carry their launch
(`launchId`, null for a late start the engine has not begun to launch), their
kind (`LATE`, `FAILED`, `REFUSED`), when they opened and closed, and how
(`resolution`); an incident is `OPEN`, `RECOVERED` (its launch went through
on its own) or `RESOLVED` (a person retried or cancelled it).

## Sessions, CSRF and CORS

- The session lives in the gateway's memory under a random id. The cookie
  holds the id signed with HMAC-SHA256; it is `HttpOnly`, `SameSite=Strict`,
  `Path=/`. A forged or altered cookie is no session at all. Signing in
  again replaces the session with a new id; signing out ends it on the
  server. A session ends after an hour without requests, or eight hours in
  all. A restart ends every session.
- The site's sessions work the same way, in a store of their own with a
  cookie of their own (`site_session`, the console's being
  `gateway_session`). Browsers keep cookies by host, not by port, so both
  APIs on one host receive both cookies: each reads its own only, and each
  store signs with a scope of its own, so a cookie or a CSRF token of one
  never verifies in the other.
- While a session exists, every mutation must carry its CSRF token in
  `X-CSRF-Token` (the token comes with `signIn` and `session` on the console,
  `signInAsListener` and `me` on the site). Requests must be JSON, which a
  page of another site cannot send without a preflight.
- CORS answers only the configured origins: the console's on the console's
  port, the site's on the site's, with credentials where the API keeps
  sessions. Any other `Origin` is refused with 403 before anything else
  happens.
- On the site, what acts for a listener (`verifyStudent`,
  `confirmSubscription`, `answerPriceChange`, `buyPrepaidPass`,
  `activatePrepaidPass`, `me { account }`) needs the site's session; without
  one it is `UNAUTHENTICATED`, before the engine hears anything
  (`PUBLIC_ACCESS` in `src/core/policy.ts`, a rule for every root field).

## Idempotency and request ids

Every mutation that changes something in the engine needs an
`Idempotency-Key` header: a new random value for each action, the same one
when retrying it. The gateway passes it to the engine untouched, and never
makes one up, because a key made up by the gateway would differ on the retry
it exists for. The engine answers a repeat with the answer it saved; the same
key with another request is refused. One request carries one mutation.

The request id comes from the `X-Request-Id` header when it is well formed
(8 to 100 letters, digits, dots, dashes, colons or underscores), and is a
new UUID otherwise. It goes to the engine with every call of the request, and
comes back in `X-Request-Id` and in the response's `extensions.requestId`.
The engine writes it into the audit log (§11.1).

## Limits

| | Console | Site |
|---|---|---|
| Depth | 8 fields | 6 fields |
| Cost | 25,000 | 600 |
| Tokens in the document | 5,000 | 1,500 |
| Body | 64 KiB | 64 KiB |

Both schemas are acyclic, so their own shape bounds the depth of any query;
the depth limits are those bounds (a test checks it), and stop the runaway
queries that a cycle added later would allow. The cost counts each field
once and multiplies a list by its size: the `first` argument of a page (the
largest page when `first` is a variable), ten for other lists. Aliases count
one by one. The console's largest page of changes with their details costs
about 22,400; the site's whole catalog of a market, with where each price
goes, about 510. The limits leave room for these and none for the same
fields asked again and again.
Batched requests and persisted queries are off.

No field lowers the cost of the others. A page counts from one row to the
largest page, whatever its `first` says, and a field under `@skip` or
`@include` counts as if it ran, since whether it runs is known only later.
A `first` written in the document must be between 1 and 100, or validation
refuses the request before anything runs: a field that `@skip` leaves out
never reaches its resolver's own check, which is what holds for a `first` in
a variable. Before this, a skipped page of minus two billion rows took its
cost away from the rest, and let twelve pages of 100 rows through.

The measure reads each fragment once per operation, however many times it is
spread, and stops as soon as it passes a limit. Read naively, fragments that
spread the one before them twice would double the work at every level: a few
hundred bytes of query could keep the gateway busy for minutes before any
limit was checked. Thirty such levels are refused in milliseconds (a test
holds that, with its threshold).

A request whose target is not a path (`//[`, say) is a 400 like any other
bad request. Whatever fails outside the handler's own answers is caught by a
last guard around it and written to the log: no request can take the
process down, and with it the other API, which lives in the same process.

Rate limits are token buckets per client address and per session; past
them the answer is 429 with `Retry-After`. They live in the process's
memory: with several instances of the gateway, each counts on its own.

## The DataLoader, measured

The console's list of offers asks for each row's details. Without batching
that is one `ListChanges` and one `GetChange` per row; with the request's
DataLoader the rows asked for in the same tick go in one `BatchGetChanges`.
For a page of 25 offers, counted where the calls arrive (the fake engine's
gRPC server):

| | Calls to the engine |
|---|---|
| Without batching | 26 (ListChanges 1, GetChange 25) |
| With the DataLoader | 2 (ListChanges 1, BatchGetChanges 1) |

```
npm run measure -w gateway
npm run measure -w gateway -- --offers 100
```

The counts do not depend on the machine. The script also prints the median
time of the request, but those times were taken on a machine running other
work, against an in-memory engine on the same machine: they are not a
benchmark and are not quoted here. Loaders live for one request, so nothing
one session read is served to another; a batch holds at most 100 ids.

## The core and the shell

`src/core/` holds the schemas' wiring, the resolvers, the loaders, the
scalars, the role matrix and the limits. It imports the `graphql` package,
DataLoader, the protobuf runtime, Connect's client and the generated
contract, and nothing that needs Node: in stage 8 the same code runs in a
browser, with the engine behind a Connect transport that reaches the page's
own engine. `test/core-boundary.test.ts` reads every import of the core with
TypeScript's scanner, and `tsconfig.core.json` type-checks the core with a
browser's types and none of Node's.

`src/node/` is the shell: the HTTP servers around Apollo Server, the
sessions, the configuration, the log, and the gRPC transport (Connect over
Node's HTTP/2) that carries the internal token. Apollo's landing page and
every reporting plugin are off: nothing leaves for an outside service.

## Tests

```
npm run check -- --only gw-types,gw-codegen,gw-schemas,gw-tests,dataloader
```

`gw-schemas` runs the contract tests of the two schemas, `gw-tests` the rest:
resolvers, roles, both APIs' sessions, CSRF, CORS, idempotency, request ids,
limits, scalars, errors, configuration, the start of `npm run gateway`
itself, the subscriber's side (`test/site-sessions.test.ts`,
`test/subscriptions.test.ts`), and stage 7 from both sides: the price
migrations (`test/price-migrations.test.ts`, `test/price-changes.test.ts`)
and the prepaid passes (`test/prepaid-passes.test.ts`). They
run the real gateway over HTTP against a fake engine
(`test/support/fake-engine.ts`): every service of the contract, in memory,
served over real gRPC on 127.0.0.1:4613, with the engine's
behaviours as the coordinator fixed them (codes, metadata, idempotency,
refusals, the role matrix written again on its own) and, for the
subscriber's service, the engine's own order of checks, its four demo
listeners and its billing schedule, and a fifth listener for §14.3, a Family
subscriber in Germany, until the engine's own §14.3 service is there. The
clock is injected, so sessions expire, quotes run out, subscriptions reach
their list price and price changes reach their deadline without waiting.

The tests listen on 127.0.0.1: the fake engine on 4613, the gateway on 4621
and 4622, after asking the system that nobody else listens there. Two copies
of the repository can run their tests side by side by moving them:

| Variable | Default | |
|---|---|---|
| `CHECK_FAKE_ENGINE_PORT` | 4613 | the fake engine of the gateway's tests |
| `CHECK_GATEWAY_INTERNAL_PORT` | 4621 | the console's API in the tests |
| `CHECK_GATEWAY_PUBLIC_PORT` | 4622 | the site's API in the tests |
| `CHECK_ENGINE_PORT` | 4612 | the real engine, in the engine's own tests and in the integration tests |

They are not `GATEWAY_` settings on purpose: `npm run gateway` refuses any
`GATEWAY_` variable it does not know, and these belong to the tests alone.

The fake engine was written with the gateway, so the two could agree on a
mistake. The integration suite runs the real ones together:

```
npm run check -- --only integration
```

It clones the migrated database, loads the small generated data (seed 7),
starts the real engine with an internal token of its own, starts the real
gateway in front of it, and walks the Student Autumn Pass of §14.1 through
HTTP only, cookies, CSRF tokens, idempotency keys and request ids included:
marketing creates it, saves a second version, validates it (finance must
sign: the price is under the floor) and submits it; marketing's approval and
the commercial lead's are refused, finance's with an old fingerprint too,
and finance's with the exact one approves it; marketing schedules it; the
site shows it at €2.99 with €5.79 struck through, and quotes €2.99 for 3
months, then €5.79, and shows where the Student price goes (§5.5: €4.75 net,
€3.00 for the artists, €0.15 of it from the music service; the offer's own
breakdown comes with the engine of stage 6, and reads null until then without
an error); the auditor finds every step in the log with the request
id the client sent, and the chain holds; a repeated idempotency key gives the
same change, and the same key for another request is refused. Last, on the
site, the demo's verified student in Italy signs in, asks for the pass's quote
and confirms it: €2.99 charged on 26 October, then on 26 November and 26
December, the list price of €5.79 from 26 January 2027, the same in their
account, the first month's payment pending at the confirmation and settled
by the provider's event shortly after (the account then has the receipt,
which says no money moved), and in the log a `subscription.confirmed`
written by the subscriber with the site's request id, the chain still whole.
And the console reads the pass's launch: one launch of the change, done, its
five steps done at one attempt each, the catalog snapshot before and after
it, and among the audit events it names the change's activation, which
carries its run as the request id.

The engine reads the machine's clock when it runs for real, and nothing in
it moves time. The test starts the same `serve()` through a launcher of its
own (`services/commerce/tests/clocked_server.py`) that hands it a clock the
test moves on standard input: from 24 October to past 09:00 in Rome on 26
October, the morning after the clocks go back. The suite reports how long the
site takes to show the offer once the clock is past the start: the passes of
the engine's jobs, 0.5 s apart in the test (5 s by default), in which the
change's launch runs its steps up to the publication; the audit log names
the launch's run (`launch-12`) as the activation's request id. With a clock
that runs on its own, the launch begins a minute before the start instead,
and the offer appears at the start. Times measured while other work ran on
the machine: they say the order of magnitude, nothing more.

The engine, the gateway and the database are stopped and dropped at the end,
also when a step fails. The suite needs `CHECK_ENGINE_PORT` (4612 by
default) besides the gateway's test ports.
