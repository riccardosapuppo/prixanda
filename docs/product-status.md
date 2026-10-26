# Product status

Written on 25 October 2026, revised on 26 October 2026.

## What the product is

Prixanda is a subscription and pricing operations platform. It keeps what a
subscription business sells: the plans and what each one includes, the price
of each plan in each market, the promotional offers and their audiences,
prepaid passes, and price changes for people who already subscribe. Prices,
offers, passes and price changes are changes with versions. An offer or a
price change is simulated before anyone signs it. Every change is signed by
someone other than its author, scheduled, and launched into the public
catalog by a job that publishes all of it in one transaction or nothing, and
resumes where it stopped. Every decision is written to an audit log.

Sonequo, an independent-music streaming service in Italy, France, Germany and
the United Kingdom, is the fictional business the platform is explored
through. Its public site is part of the repository, so a decision taken in
the console can be followed to the moment a listener sees it.

## The problem

A subscription business changes prices and runs promotions all the time, in
several markets, with several people involved. When that work lives in
spreadsheets and admin screens, the failures are familiar: a promotion goes
live without the signature it needed; two offers for the same audience
collide; a discount sells below a floor the business promised someone; a
launch fails halfway and the site shows a price that is not in force; an
increase reaches existing subscribers in a market where it needed their
consent. Prixanda turns each of those into a rule that the engine enforces,
and the database enforces again where it can, with a simulator that shows the
cost before anyone signs.

## What works

All of it is implemented and covered by the tests that `npm test` runs.

### Changes, versions and approvals

Offers, list prices, price changes for existing subscribers and prepaid
passes are all changes, with one state machine: draft, validated, in
approval, approved, scheduled, active, ended, and suspended or cancelled on
the way. An approval names the exact version and its content fingerprint, and
a new version clears earlier signatures. The author of a version cannot
approve it: the engine refuses, and so does a database constraint. The
database already knows a plan's entitlements as a kind of change, but writing
one is not built yet.

### Prices and money

Each plan has a list price per market, with periods that cannot overlap (a
PostgreSQL exclusion constraint), dated VAT per market, euro and pound
sterling, amounts as integers in minor units, and every date read in the
market's own time zone.

### Offers and their rules

Eligibility covers new subscribers, verified students and the fans of an
artist, by their listening. The engine checks clashes between offers, the
artists' guaranteed minimum per subscription, and the conditions that call
for finance's signature. A quote saves the price a subscriber was shown, its
months and the price after them; the subscription it confirms knows the day
the full price starts.

### The simulator

It projects subscribers, revenue, the artists' pool and the cost of topping
it up over a horizon, from assumptions that are shown and can be changed,
with no machine learning.

### Launches

A launch is a job in five steps (check, prepare, publish, notify, verify)
that resumes from the right step after a crash. The catalog is published in
one transaction, an outbox tells the site, a late launch raises an alarm in
the console, and incidents are opened and resolved. The fault tests stop the
engine and cut the database connection at every step, then count the partial
activations left behind: zero.

### The audit log

The log is append-only for the engine's database role, guarded by triggers
against the table's owner too, chained with SHA-256 and verifiable, with an
export of the chain's head to keep elsewhere.

### The public site

The site shows plans and offers per market, with a simulated student
verification and a demo subscription through a simulated payment provider,
whose events count once even when they arrive twice or out of order. The
account page carries the consent request for a price increase in Germany, and
the prepaid gift pass comes with its single-use code.

### Six scenarios end to end

Each scenario has its business reason in
[business.md §14](business.md#14-the-six-scenarios): the Student Autumn
Pass, the album release for an artist's fans, the family price increase in
Germany, the prepaid gift pass, student verification, and the safe launch. A
second fictional company with seat-based plans runs through the same flows in
the tests, to show the platform does not depend on music.

### The browser sandbox

The same Python engine runs in the page on Pyodide, over PostgreSQL in
WebAssembly (PGlite) built from the same migration files, behind the same
GraphQL schemas and resolvers. A test compares the schema PGlite ends up with
against the one Flyway builds.

## What is synthetic

The company, its artists, labels and albums, its subscribers and their
listening, its revenue and its payments. The data comes from a generator with
a fixed seed, in a small size for the tests and the sandbox and a full size
for the measurements. People carry no names: the team is named by role,
subscribers by number, and the demo's listeners are labelled as simulated.
Artists, labels and albums have invented names.

## What is simulated

Payments go through a simulated provider behind an interface, where a real
provider would plug in; nothing is charged, and the site's buttons say demo
("Confirm demo subscription", "Confirm the demo purchase"). A simulated
provider also answers the student verification.

People enter with a role. The permissions behind each role are real and
enforced by the gateway and the engine, but nobody proves who they are, since
there is no identity provider.

In the browser sandbox the fault is simulated, and the sandbox says so; the
real fault tests run on the full system. The sandbox also has its own clock,
so that a launch scheduled for 09:00 can be reached in a minute.

## What stands between this and commercial use

More detail is in [production-readiness.md](production-readiness.md) and
[legal-and-licensing.md](legal-and-licensing.md).

- Authentication: no identity provider, no single sign-on, no multi-factor
  authentication, no management of users and their roles.
- Payments and money: no payment provider, no invoices or receipts with legal
  value, no tax beyond each market's VAT rate, no accounting or revenue
  recognition beyond the prepaid value not yet earned.
- Running it: no deployment target, container images or infrastructure as
  code; no secrets manager; no high availability; no backups or
  point-in-time recovery beyond what a managed PostgreSQL would provide.
- Observability: structured logs, request ids from the browser to the audit
  log, health checks and the launch alarm, but no metrics or tracing backend.
- Market rules: modelled as configurable policies with their sources, which
  is not a verification of legal compliance in any market. A launch would
  need its own review of tax, consumer protection, contract and privacy
  obligations.
- Names: Prixanda and Sonequo were checked against trade-mark registers,
  software, packages and domains by the author, not cleared by a trade-mark
  professional.
- Scale: one company at a time, with a second only in the tests; the
  measurements are on synthetic data on a single development machine, not
  benchmarks of a deployment.
