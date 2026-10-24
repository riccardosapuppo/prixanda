# Plancia

*Provisional name.* An independent personal software project: a subscription and
pricing operations platform.

Plancia governs what a subscription business sells: the plans and what
they include, the price of each plan in each market, the promotional offers,
who has to sign them, and when they reach the public catalog. Every change is
a version, every version is approved by someone other than its author, and
every decision lands in a hash-chained audit log. The rules that matter most
are enforced twice: by the engine and again by the database.

The platform is explored through a fictional business. **Rione**, a provisional name too, is an
independent-music streaming service in Italy, France, Germany and the United
Kingdom, and it makes one promise that shapes every price: each paying
subscription pays the artists at least €3.00 (£2.60) a month, whatever
discount the subscriber is on. A promotion below that floor costs Rione the
difference out of its own margin, so it needs finance's signature. The
company, its artists and its subscribers are invented and the data is
synthetic; the arithmetic, the approval rules and the audit log are real. The
business book behind every feature is [docs/business.md](docs/business.md).

> Independent personal project. Fictional business and synthetic customer
> data. No real payments are processed.

## Status

The platform is being built in eight stages. Done so far:

- **Stage 1, data and rules in the database.** Flyway migrations for markets,
  dated VAT rates, plans and entitlements, the price list, versioned changes
  and their approvals, the audit log, subscribers and listening data; a
  deterministic data generator in two sizes; the invariants no single
  constraint can hold, checked on the generated data.
- **The gRPC contract** between the engine and the gateway, in
  [proto/](proto/), with the code it generates for both sides.

Next: the engine's services in Python (stage 2), the GraphQL gateway (3), the
console and the public site (4, 5), safe launches with real fault injection
(6), the remaining business scenarios (7), and a sandbox that runs the whole
system in a browser (8).

## What the database refuses on its own

Each line is a test in [services/commerce/tests](services/commerce/tests) that
expects PostgreSQL to refuse, with its error code:

- two prices for the same plan and market whose periods overlap (an exclusion
  constraint); a price for the free plan; a price in a currency that is not
  the market's;
- editing a price in force, other than closing its open period once;
- an approval by the version's author; by someone who does not hold the role
  they sign with; for a version or a content fingerprint that is not the
  current one; a second signature from the same person on the same version;
- a change skipping a state of the approval workflow, reaching "approved"
  without a signature, or keeping its approvals after a new version;
- any update, delete or truncate of the audit log, by the engine's role and
  by the table's owner.

What the audit log's hash chain really guarantees: an event changed, removed
or reordered after the fact is detected by recomputing the chain. It is not
prevented, since an administrator of the database can rewrite the whole chain
consistently; that is caught only by comparing it with a head exported earlier
and kept elsewhere, and a test does exactly that. Tamper-evident against that
anchor, not immutable. The platform is designed around SOX-style separation of
duties and auditable approval controls; it is not certified against any
standard.

## Before you start

- Node.js 24 or later, with its npm.
- Python 3.13, the version the browser sandbox will run the same engine on.
- The first `npm run setup` downloads Flyway's command line for PostgreSQL and
  the Java runtime it runs on: 59.9 MB, every file pinned by checksum in
  [tools/flyway-lock.json](tools/flyway-lock.json), from Maven Central and
  Adoptium. Nothing is installed on the system.
- Disk, measured on Windows: `node_modules` 282 MB (109 MB of it is
  PostgreSQL), `.venv` 51 MB, Flyway and its Java runtime 163 MB in `.tools`.
- Not needed: Docker, an installed PostgreSQL, an installed Java. PostgreSQL 18
  comes as an npm package and runs from the repository, started and stopped
  with its own `initdb` and `pg_ctl`.
- On Windows, PostgreSQL 18 needs the Microsoft Visual C++ Redistributable
  14.40 or later (an older one makes `initdb` crash).
- Everything the tools write stays inside the repository (`.tools`, `.data`,
  `.venv`, `node_modules`), apart from the npm and pip caches.

## Running the checks

```
git clone https://github.com/riccardosapuppo/subscription-offers-platform.git
cd subscription-offers-platform
npm ci
npm run setup
npm test
```

`npm test` starts a throwaway PostgreSQL 18 on 127.0.0.1:4602, applies the
migrations with Flyway, checks the gRPC contract against its generated code,
runs the Python tests against the database, generates the small synthetic
dataset and checks every invariant on it, then stops the cluster and removes
it. Each suite must reach a written minimum number of checks: a suite that
checked nothing does not pass.

The site's suites (stages 5 and 7) check its types, its GraphQL operations
against the public schema, its unit tests, its static build, and, end to end,
the whole system with a headless Chromium: the Student Autumn Pass launched,
on the site within a measured time, a student subscribed at the right price,
every step in the audit log, the same journey on the keyboard alone, and the
pages fitted at five widths (site-e2e); a gift pass bought and activated,
the Family subscriber in Germany asked for consent and the Individual
subscriber in Italy told in advance, each with the engine's dates, and the
code in no log line (site-e2e-7). Run them alone with
`npm run check -- --only site-types,site-codegen,site-unit,site-build,site-e2e,site-e2e-7`;
the end-to-end tests need Playwright's Chromium (`npx playwright install
chromium`, a download) and are reported as not run without it. Details in
[apps/site/README.md](apps/site/README.md).

A local development database, kept between runs in `.data`:

```
npm run db -- start
npm run db -- info
npm run db -- stop
```

On Windows, stop it before `npm ci`: the server runs from `node_modules`, and
Windows does not let npm delete a file that a running program has open, so the
reinstall stops halfway and leaves `node_modules` incomplete.

## The console

The commercial team's console (stage 4) is a static Next.js export in
[apps/console](apps/console), with its own README. From the root:

```
npm run console:stack
npm run build -w console
node apps/console/e2e/run.ts
npm run check -- --only design,console-types,console-codegen,console-unit,storybook,console-build,console-e2e
```

The first starts the development database, the engine, the gateway and the
console on 127.0.0.1:4631; the second writes the static export; the third
runs the end-to-end tests on the whole system with a throwaway database; the
last runs the console's suites with their floors. Playwright and Storybook
run headless, and every request leaving 127.0.0.1 is refused.

## The demo in the browser

The same site and console run with no server at all in the demo (stage 8):
the engine's Python code in Pyodide over PGlite, with the same migrations,
and the gateway's core, in one worker that every tab of the address shares.
`npm run demo:build` builds the three parts with `SANDBOX=1` and assembles
them in `dist/demo/` (the site at `/`, the console at `/console/`, the
sandbox at `/sandbox/`); `npm run demo:serve` serves it on
http://127.0.0.1:4651. The check's suite `demo` builds it, serves it and
drives headless Chromium through its journeys; it reports itself as not run
while a part cannot be built yet.

## Layout

| Folder | What |
|---|---|
| `db/migrations` | the schema and its rules, applied by Flyway |
| `services/commerce` | the engine in Python: database access, the data generator, the invariants, and, from stage 2, the services |
| `proto` | the gRPC contract; `npm run proto` regenerates `packages/contracts` (JavaScript) and the engine's Python modules |
| `apps/console` | the console: Next.js built to static files, its Storybook and its end-to-end tests |
| `apps/site` | the public site of the fictional service: a static Next.js build on the gateway's public API |
| `packages/design` | what the console and the site share: tokens, fonts, icons, the writing of money |
| `tools` | PostgreSQL and Flyway without installing them, the setup, the checks |
| `docs` | the business book |

## License

MIT, see [LICENSE](LICENSE). Developed by Riccardo Sapuppo.
