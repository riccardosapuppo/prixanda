# Production readiness

Written on 25 October 2026. In the parts that exist, the platform's rules are
enforced on the server and in the database, its writes are idempotent, its
launches recover, and its tests run on Linux and Windows. It is not ready to
take real money or to hold real people's data, and this page says why, part
by part.

## Verified behaviour

`npm test` runs every suite against a throwaway PostgreSQL 18 and fails when a
suite checks fewer cases than its written floor, or skips one. The continuous
integration runs the same command on Ubuntu 24.04 and Windows Server 2025 on
every push to main, on every pull request and once a week. The README lists
what each suite covers.

On 25 October 2026, on commit 3624502, all 43 suites passed; the README
lists them with what each counted.

What the tests establish, in short:

- the database refuses what no row may hold: overlapping prices,
  self-approval, an approval for a stale version, a skipped state, any change
  to the audit log;
- every engine call has a test over gRPC, errors included, and the business
  book's figures are reproduced as golden cases;
- the quote's invariants hold for the cases Hypothesis generates;
- both GraphQL schemas match their written contracts, and the public one
  exposes no internal field;
- faults injected at every step of a launch leave no partial activation;
- a database migrated from the previous release, with its data, passes the
  invariants, and the previous release's reads keep working during the
  expand phase of the two-step schema change;
- the console and the site run the six scenarios end to end with a headless
  browser, on the keyboard alone for the main path, with axe reporting no
  serious violation.

## Security

The threat model, threat by threat, is in [threat-model.md](threat-model.md).
What holds today follows.

### Authorization on the server

Every engine method that acts for a member of the team has the roles allowed
to call it, checked by the gateway and again by the engine. The site's
methods act for nobody, or for the listener of the site's session, whom the
gateway names. Separation of duties (an author never approves their own
version) is also a database constraint, and approvals name an exact version
and its content fingerprint.

### Two APIs

The console's API and the site's public API are separate schemas on separate
ports. A test walks the public schema and fails on any internal field or
identifier.

### Sign-in

Signing in is a demonstration: people pick a role, and nothing proves who
they are. The sessions themselves are real (random ids in HttpOnly,
SameSite=Strict cookies signed with HMAC-SHA256, a CSRF token on every
mutation made within a session, an idle and an absolute expiry). In
production mode the gateway refuses to serve the console's API at all and
keeps no sessions on the site's API, so a browser can never choose its own
privileges in a production deployment. What a real deployment needs (OpenID
Connect, roles from the identity provider) is written in the gateway's
configuration.

### Abuse, replays and duplicates

Query depth and cost are limited before execution, pages hold 1 to 100 rows,
and token buckets limit requests per session and per address. Every call
that changes something carries an idempotency key: a repeated call returns
the first answer, a key reused for a different call is refused, and keys are
pruned after seven days. Payment events count once, whatever their order.

### Secrets and queries

The engine's internal token and the session signing key come from the
environment and are never logged. In production the token is required, and
no session key is needed, since neither the console's API nor the site's
sessions run there; in development each is generated once into `.data`,
which git ignores. All SQL is parameterised.

### The audit log

The log is append-only for the engine's role, guarded by triggers and chained
with SHA-256. The chain detects an event changed, removed or reordered. It
does not stop an administrator of the database from rewriting the whole chain
consistently; only a comparison with a head exported earlier and kept
elsewhere reveals that.

### Dependencies

Versions are pinned, a rule of no package younger than two weeks is applied
by hand at each upgrade, except for a security fix, and `npm test` checks the
licence of every package. On 26 October 2026 the project moved to Next.js
16.4.3, Storybook 10.6.2, body-parser 2.4.0 and, for the engine, protobuf
6.33.5, and npm's audit and GitHub's advisory database then found no advisory
in the npm packages or in the engine's Python environment. The browser
sandbox still serves the protobuf 6.31.1 that Pyodide ships: its advisory
concerns JSON parsing, which the engine does not use.

## Deployment

There is no deployment yet. Everything runs on one machine: PostgreSQL 18
from an npm package, the engine as a Python process, the gateway as a Node
process, the console and the site as static files. A real deployment would
need, at least: container images or packages for the engine and the
gateway; a managed PostgreSQL 18; TLS in front of both APIs; a secrets
manager; separate network access for the console's API; and a release
process for migrations, which Flyway applies forward only.

The browser sandbox is a static build: any static host can serve it, as long
as it sends WebAssembly files as `application/wasm`.

## Observability

The gateway writes one JSON object per line, with the request id, and never
writes secrets, cookies or client addresses; the engine writes JSON lines
too. Request ids are born in the browser, travel through the gateway to the
engine, and are written in the audit log with each event. The engine answers
the standard gRPC health service and the gateway answers `/health`. A launch
that does not start on time raises an alarm in the console, and each step and
each incident is visible on the launch's page.

Metrics, distributed tracing and a place that collects all of it are
missing. OpenTelemetry was left out because traces had to stay on the
machine, where nothing would read them.

## Backup and recovery

Inside the product, a launch resumes from the step it reached, the outbox
delivers what the catalog's transaction committed, idempotency keys make a
retried call safe, the two-step schema change has a compatibility test, and
the audit chain is verified on demand and against an exported head.

Outside the product there is nothing. The PostgreSQL package the repository
uses has no `pg_dump`, and no backup, point-in-time recovery or restore drill
exists. A deployment would rely on a managed database's backups and would
need its restores tested.

## Incident response

The [runbook](runbook.md) covers a stuck launch, an engine that cannot be
reached, an audit chain that does not verify, an upgrade across the two-step
migration, and a month of listening data without its partition. The on-call
engineer's role can suspend an offer and retry or cancel a launch, and cannot
create or approve anything. There is no paging, no on-call rota, and no
status page.

## Missing for real adoption

- Authentication with an identity provider, user management, and roles from
  a directory.
- A payment provider, invoicing, tax beyond VAT rates, accounting.
- Deployment, secrets management, backups and their restores, high
  availability.
- Metrics, tracing and alerting outside the console.
- A privacy and legal review per market ([legal-and-licensing.md](legal-and-licensing.md)).
- Load tests beyond the measurements on synthetic data in the README.
- More than one company at a time: the second company exists only in the
  tests.
