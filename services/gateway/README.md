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
| Console's API | `schema/internal.graphql` | 4621 | changes, approvals, simulations, the audit log, the home's numbers |
| Site's API | `schema/public.graphql` | 4622 | markets, plans, list prices, offers on sale, quotes |

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

The gateway refuses to start in any other mode (`GATEWAY_AUTH` accepts
`demo` only), and refuses to serve the console's API in production
(`GATEWAY_ENV=production` or `NODE_ENV=production`), because there the
browser must never choose its own privileges. In production it can serve the
site's API alone (`GATEWAY_ENDPOINTS=public`).

A real deployment needs OpenID Connect: an identity provider that signs ID
tokens; the gateway verifying issuer, audience, expiry and signature; roles
taken from the provider's claims or a server-side directory, never from the
browser; and sessions bound to the verified identity. None of that exists
here.

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
| `GATEWAY_SESSION_SECRET` | `.data/gateway-session-secret` in development | secret that signs session cookies, 64 hex digits or more |
| `GATEWAY_ENV` | `development` | `production` turns introspection off and the console's API away |
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
set; the session key is not needed there, because the console's API does not
run in production.

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

Plans and their entitlements, list prices, offers on sale, quotes. Nothing
about floors, the artists' pool, top-ups or margins, no changes, versions or
approvals, no people, no audit log. Three tests check it, each from another
angle (`test/public-contract.test.ts`):

1. the whole surface of the schema (types, fields, arguments, enum values,
   union members) equals a list written in the test, in both directions;
2. no name in it belongs to the internal vocabulary (with one exception,
   named in the test: a visitor may be told `NOT_ELIGIBLE`);
3. an engine that plants marked values in every internal field of its
   messages answers every public field, and none of the marks comes out.

No argument or input of the site's schema can carry money: the price is
always the engine's (§4.5).

## Answers and errors

A business refusal is an answer. Every mutation that reaches the engine
returns a union of its result and a `Refusal` with its code
(`OWN_VERSION`, `STALE_VERSION`, `ROLE_NOT_ALLOWED` and the others of the
contract), its reason and its facts. A refusal about a change carries the
change as it is now: with `STALE_VERSION`, the newer version (§6.3).

Errors carry `extensions.code`:

| Code | When |
|---|---|
| `UNAUTHENTICATED` | no session, or it ended |
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
are for finance and the commercial lead only; the other roles get
`FORBIDDEN` on those fields and the rest of the home.

## Sessions, CSRF and CORS

- The session lives in the gateway's memory under a random id. The cookie
  holds the id signed with HMAC-SHA256; it is `HttpOnly`, `SameSite=Strict`,
  `Path=/`. A forged or altered cookie is no session at all. Signing in
  again replaces the session with a new id; signing out ends it on the
  server. A session ends after an hour without requests, or eight hours in
  all. A restart ends every session.
- While a session exists, every mutation must carry its CSRF token in
  `X-CSRF-Token` (the token comes with `signIn` and `session`). Requests must
  be JSON, which a page of another site cannot send without a preflight.
- CORS answers only the configured origins: the console's on the console's
  port (with credentials), the site's on the site's. Any other `Origin` is
  refused with 403 before anything else happens.

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
| Depth | 8 fields | 3 fields |
| Cost | 25,000 | 600 |
| Tokens in the document | 5,000 | 1,500 |
| Body | 64 KiB | 64 KiB |

Both schemas are acyclic, so their own shape bounds the depth of any query;
the depth limits are those bounds (a test checks it), and stop the runaway
queries that a cycle added later would allow. The cost counts each field
once and multiplies a list by its size: the `first` argument of a page (the
largest page when `first` is a variable), ten for other lists. Aliases count
one by one. The console's largest page of changes with their details costs
about 22,400; the site's whole catalog of a market about 330. The limits
leave room for these and none for the same fields asked again and again.
Batched requests and persisted queries are off.

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
resolvers, roles, sessions, CSRF, CORS, idempotency, request ids, limits,
scalars, errors, configuration, and the start of `npm run gateway` itself.
They run the real gateway over HTTP against a fake engine
(`test/support/fake-engine.ts`): every service of the contract, in memory,
served over real gRPC on 127.0.0.1:4613, with the engine's behaviours as the
coordinator fixed them (codes, metadata, idempotency, refusals, the role
matrix written again on its own). The clock is injected, so sessions expire
and rate limits refill without waiting.

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
months, then €5.79; the auditor finds every step in the log with the request
id the client sent, and the chain holds; a repeated idempotency key gives the
same change, and the same key for another request is refused.

The engine reads the machine's clock when it runs for real, and nothing in
it moves time. The test starts the same `serve()` through a launcher of its
own (`services/commerce/tests/clocked_server.py`) that hands it a clock the
test moves on standard input: from 24 October to past 09:00 in Rome on 26
October, the morning after the clocks go back. The suite reports how long the
site takes to show the offer once the clock is past the start: one tick of
the engine's activation timer, 0.5 s in the test (5 s by default). With a
clock that runs on its own, activation comes a minute before the start
instead, and the offer appears at the start exactly. Times measured while
other work ran on the machine: they say the order of magnitude, nothing more.

The engine, the gateway and the database are stopped and dropped at the end,
also when a step fails. The suite needs `CHECK_ENGINE_PORT` (4612 by
default) besides the gateway's test ports.
