# Sandbox

The demo in the browser: the whole platform, with no server, in the
visitor's browser. One worker per origin holds the engine, its own Python
code in Pyodide on PGlite, and the gateway's core over it; the site and the
console of the same address talk to it as they would talk to the gateway
over HTTP. The data stays in that browser, in IndexedDB.

`npm run demo:build` assembles the demo in `dist/demo/`: the site at `/`, the
console at `/console/`, and this package at `/sandbox/`. `npm run demo:serve`
serves it on 127.0.0.1:4651 (`DEMO_PORT`). Nothing comes from another host:
Pyodide, its wheels, PGlite and the fonts are files of the build.

## One worker for the origin

A SharedWorker is the same instance only for the same script and the same
name, so the worker is built on its own and served at one address,
`/sandbox/backend.js`, under one name, `offers-sandbox` (`src/protocol.ts`);
both apps open it through `src/client.ts`. Chromium lets no SharedWorker
start workers of its own: PGlite, Pyodide and the gateway's core share its
one thread. Where a browser has no SharedWorker (Chrome on Android), each tab
gets a dedicated worker of its own, and the origin's Web Lock on the data
keeps two of them from opening the same database: a second tab waits until
the first one closes, and says so.

## The engine's half: `src/engine/`

`startEngine({ base, database, token, onProgress })` gives a `BrowserEngine`:
a call of the contract in protobuf's bytes, answered in bytes or with gRPC's
status code and message as the server would send them; a pass of the jobs
(`tick`), which says what it changed in five words (`catalog`, `changes`,
`launches`, `accounts`, `audit`); the demo's clock; the simulated fault; the
skip to the next launch; and the start over.

- **Python.** Pyodide 0.29.5, which is Python 3.13.2, with the two wheels the
  engine imports, protobuf 6.31.1 and tzdata, checked against the hashes of
  Pyodide's own lock file. The server's engine runs protobuf 6.33.5; the
  contract's generated code is for 6.31.1, and both accept it. The engine is the `commerce` package as a zip
  built from `services/commerce/src`: the domain, the services, the
  contract's messages and `commerce.browser`; not the server's process, not
  the tools, nothing that imports grpc or asyncpg.
- **The database.** PGlite 0.5.8, PostgreSQL 18.3 compiled to WebAssembly,
  with btree_gist, kept in IndexedDB. `services/commerce/src/commerce/browser/
  pglite.py` is the engine's database on it: one session, its transactions
  queued one after the other, the values as asyncpg gives them to the
  server's engine, a refusal's SQLSTATE kept, the engine's own role
  (`commerce`), so the grants of the migrations hold, and every write saved
  in IndexedDB before it answers.
- **The migrations.** The same files as Flyway's on the server, applied by a
  runner (`migrations.ts`) that writes `flyway_schema_history` as Flyway does,
  checksums included: a newer build applies its new migrations to the data a
  visitor kept, and data this build cannot account for (a migration changed,
  or one it does not have) is not opened: the demo starts over from the
  build's data, and says so.
- **The snapshot.** The build makes the data a first visit loads, instead of
  migrating and generating it in the browser (`build/snapshot.ts`): a new
  cluster, the migrations by the same runner, the small data written by the
  server's own generator, run in Pyodide through the same adapter, the
  tables rewritten tight, the statistics gathered. The cluster is the
  server's locale, C, keeps its WAL in segments of 1 MB, since PGlite saves
  to IndexedDB the whole of every file a commit touches, and has no template
  databases, which only CREATE DATABASE reads. The build reads the snapshot
  back and checks its data's fingerprint.
- **The story's clock.** The demo keeps the time of its story, not the
  machine's: every visit starts where the snapshot says the story starts,
  at 08:30 in Rome on the morning after the data's last day (25 October 2026
  with the default period), so that the weeks of listening and the
  campaigns' dates stay where the story puts them, on whatever day the visit
  comes. The clock runs while the demo is open, jumps forward when asked,
  never back, and stands still while no tab is open; the start over takes it
  back to the start of the story.
- **The simulated fault.** Armed on a step of the next launch, it lets the
  step do its work, then fails it before it commits: the database keeps none
  of it, and the launch's own code tries the step again, as after a cut
  connection. The step's error, the launch's history and the log say it was
  simulated by the demo. The faults of the full system are injected by the
  engine's own tests, which stop its process (`services/commerce/tests/
  faults`).
- **The skip to the next launch** moves the clock to the moment the next
  launch is due, runs its steps there, each attempt after a fault at its own
  moment, and ends at the change's start, so that it is in force; no alarm
  goes off, since the launch starts on time.

What differs from the server, and stays so: one database session instead of
a pool, so transactions queue and never race; no statement timeout; the
story's clock; the fault, simulated. The payments and the student checks are
simulated on the server too (§10 and §15 of the business book).

## The gateway's half

The worker (`src/worker.ts`, bound to its scope by `src/backend.ts`) starts
the engine and the gateway's browser shell once for the origin, through a
Connect transport over the engine's binary call (`src/gateway/transport.ts`),
with an internal token it makes at random when it starts. It keeps each
API's session as a browser keeps an origin's cookies, runs the engine's jobs
every second and after every request, tells every tab what they changed,
and answers the demo's commands. `services/gateway/README.md`, in its
section «In the browser», tells that half.

## The protocol

`src/protocol.ts` holds every message between a tab and the worker, both
ways, and the functions that refuse a message of any other shape. A tab says
hello with its app and its build; the worker answers with its steps while it
starts (progress), then ready with its build, which a tab of another deploy
finds different and reloads for, or failed. A `graphql` message is a request
as the HTTP shell would get it at `/graphql`, its reply the status, headers
and body it would send. The commands say where the demo stands, start it
over, arm and clear the simulated fault, and skip to the next launch. After
the jobs ran, the worker tells every tab what to read again (`changed`), and
after a start over, that it happened (`reset`).

## The build

```
npm run build -w sandbox
```

writes `packages/sandbox/dist/` (`scripts/build.ts`): the engine's files
first (`src/engine/build/assets.ts`), in `runtime-<hash>/`, named by the
hash of what it holds, with `pyodide/` (only the files Pyodide needs, and the
two wheels) and `pglite/` (its modules, its WebAssembly, its files and
btree_gist), and in `engine/` (the package's zip, the migrations, the
snapshot, and `manifest.json`, which names them and the runtime folder by
their hash and gives the start of the story). Every name but the manifest's
carries a hash, so the host lets a browser keep those files for good: a visit
after the first asks only for the worker and the manifest. Then the worker,
bundled by esbuild into `backend.js`,
with its source map and the licences of what it holds. Nothing is
downloaded: the wheels come from `npm run setup`, which checks a copy that
`PYODIDE_PACKAGES` or `.tools/pyodide-packages.json` points to, and otherwise
downloads them from Pyodide's CDN and checks them.

## Checks

```
npm run check -- --only sandbox-types,sandbox-build,sandbox-schema,sandbox-services,sandbox-node,sandbox-browser,sandbox-measure,sandbox-gateway,sandbox-worker,demo
```

| Suite | What it proves |
|---|---|
| `sandbox-types` | the engine's side type-checked with a browser's types and none of Node's, and its build and tests with Node's |
| `sandbox-build` | the engine's files built: the wheels checked against the lock, the package without grpc or asyncpg, every migration in the snapshot, the small data in it |
| `sandbox-schema` | the snapshot's schema equal to the one Flyway builds on PostgreSQL 18 (tables, columns, constraints, indexes, triggers, functions, grants, the migrations' history and checksums), a change in it found, and its data with the fingerprint of the server's generator; left out, and said so: the schema `demo`, the sandbox's own state |
| `sandbox-services` | the engine's service tests, unchanged, on PGlite through the browser's adapter |
| `sandbox-node` | the engine in Pyodide on PGlite in Node: every module of the package imported, gRPC's codes, a campaign from draft to subscription through a simulated fault, the skip to the next launch, idempotency, the clock, the start over |
| `sandbox-browser` | the engine in headless Chromium, every other host unreachable: a SharedWorker with every file from the page's origin, the data kept when every tab closed and the clock resumed, two tabs on one engine, the start over, a first visit cut short, a dedicated worker, no error in the console |
| `sandbox-measure` | the engine's measuring tool tried once |
| `sandbox-gateway` | the gateway's side: its types, the protocol, the client and the worker under Node, the worker's bundle and its size |
| `sandbox-worker` | the worker's bundle in headless Chromium, with a canned engine and with the engine's own side: §14.1 from the console's tab to the site's through a simulated fault, the data kept, the start over |
| `demo` | the demo assembled and served, headless Chromium on its journeys, no request leaving the origin, axe |

Each suite must reach the minimum written in `tools/check.ts`.

## Measurements

```
npm run measure:sandbox       # the engine alone in its own worker
npm run measure -w sandbox    # the worker as the demo ships it
```

Both run headless Chromium with every host but 127.0.0.1 unreachable, the
files served with gzip and a static host's cache headers, a first visit from
an empty browser (no HTTP cache, no IndexedDB), and the first visit again
through 20 Mbit/s with 40 ms of latency. They write the machine and the
conditions beside the numbers, in `reports/sandbox-measure.json` and
`reports/sandbox-worker-measure.json`.

Measured on 25 October 2026, three runs each and the median given, on an
Intel Core i7-10700 (8 logical processors) with 12 GB of memory, Windows 10
Pro, Node.js 24.19 and Chromium 151, running nothing else: before each of
the two commands 1.4% and 3.1% of the processor was in use, and 4.2 and
4.1 GB of memory free.

The engine alone (`npm run measure:sandbox`): a first visit is ready in
4.0 s after 18.7 MB downloaded, and in 14.8 s through 20 Mbit/s with 40 ms
of latency; a read takes 57 ms (the first one 118 ms) and a write 102 ms; a
second tab is ready in 109 ms; a later visit, once every tab closed, in
3.8 s; the browser holds 767 MB with two tabs open. The engine's files are
36.7 MB, 6.6 MB of them the data's snapshot, and travel gzipped.

The worker as the demo ships it (`npm run measure -w sandbox`), with a read
of the markets and Italy's plans and a write of a quote, through the gateway
in the worker: a first visit is ready in 4.5 s after 18.9 MB downloaded, and
in 13.1 s through the slower network; a read takes 93 ms (the first one
177 ms) and a write 97 ms; a second tab is ready in 17 ms; a later visit in
4.0 s.
