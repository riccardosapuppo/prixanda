# Site

The public site of the fictional music service (Rione, a provisional name):
the plans and their prices in each market, the campaigns on sale, and the
journey of a demo listener who checks as a student, subscribes at the price
the engine quotes, and finds it all in their account. It is a static Next.js
build: HTML, CSS and JavaScript that any web server can serve, with every
figure asked for by the browser from the gateway's public API.

Nothing here is a real purchase. The listeners are invented, the student
verifier and the payment provider are simulated, and the receipt says so.
The site says it too: a pair of labels at the top of every page, one sentence
in the footer, and the full disclaimer next to the one button that could
pass for a purchase, "Confirm demo subscription".

## Running it

Three processes, each on its own port, with the development data:

```
npm run engine                                   # PostgreSQL, migrations, small data, the engine (4611)
GATEWAY_SITE_ORIGINS=http://127.0.0.1:4632 npm run gateway
npm run build -w site && npm run serve -w site   # the static build on http://127.0.0.1:4632
```

On Windows PowerShell the second line is
`$env:GATEWAY_SITE_ORIGINS="http://127.0.0.1:4632"; npm run gateway`. The
gateway refuses any browser origin it was not given, so without that setting
the site's requests are turned away. `npm run dev -w site` runs Next.js's
development server on the same port instead of the build.

The build calls the API written into it at build time: `NEXT_PUBLIC_SITE_API`,
`http://127.0.0.1:4622/graphql` when unset (the gateway's public port as
`npm run gateway` starts it).

## Pages

| Page | What it shows |
|---|---|
| `/?market=IT` | A market's plans and the campaigns on sale there. Its design is being redrawn in the mock-ups: this is the working structure, on the data it will keep |
| `/campaign/?market=IT&offer=42` | One campaign as the engine published it: its months drawn as sails, the price struck through and the offer price, the promise to the artists from the engine's breakdown of the offer price, and the steps of taking it |
| `/account/` | The demo listener's plan, price, months left at an offer's price, the day the full price starts, the student check, and the first month's payment with its demo receipt |

A campaign page exists if and only if its offer is on sale (business book
§7.5): asked for one that is not, it says so. An open page asks for the
offers on sale every 10 seconds, so a launch shows up without a reload.

## How a page gets its data

- **One way to the API.** Pages ask through the hooks of `src/data/hooks.ts`
  (TanStack Query); the hooks call the operations of `src/graphql`; the
  operations go through a transport (`src/data/transport.ts`). Today the
  transport is HTTP to the gateway. The browser sandbox of stage 8 hands the
  same data layer a transport that executes the same schema in the page, and
  nothing above the transport changes.
- **Types from the schema.** `npm run graphql -w site` validates every
  operation against `services/gateway/schema/public.graphql` and generates
  `src/graphql/generated.ts`: each operation's text with its result and
  variables types. A page can read only what its operation asked for.
- **The price is the engine's.** No request carries a price. The site names
  the plan, the market and the offer, shows the quote that comes back, and
  confirms it by its id (§4.5). Money stays a string of minor units and is
  written by `formatSitePrice` (`packages/design`) the way each country writes
  it: 10,49 € in Italy and Germany, 10,99 € in France, £9.49 in the United
  Kingdom. Dates are the engine's, put into words.
- **Request ids born in the browser.** Every request carries a new
  `X-Request-Id` (`site-<uuid>`); the gateway passes it to the engine, which
  writes it into the audit log with whatever the request changed (§11.1).
- **One idempotency key per action.** Checking a student, asking for a quote
  and confirming a subscription each send an `Idempotency-Key` made when the
  visitor acts, and the same one if that action is retried.
- **The session is the gateway's.** Entering as a demo listener sets an
  HttpOnly cookie of the gateway; the browser sends it to the API's origin
  (`credentials: "include"`) and the CSRF token it was given back with every
  mutation. The page never holds an identity of its own.
- **Refusals are answers.** "This offer isn't for this listener" comes back
  as data and is shown as such; an error (the API unreachable, the engine
  down) is shown with what to do and the request's reference.
- **The payment settles later.** The confirmation leaves the first month's
  payment pending; the account reads it again every second, for 30 seconds at
  most, until it succeeds or fails, then says plainly that the provider has
  not answered yet and offers to check again.

## The editorial catalogue

The labels, their records and the liner notes (`src/content/editorial.ts`)
are content of the fictional service, written for the site. They are not
data of the platform, which governs what is sold, at what price and with
whose signature, and has no say over a liner note. They reach the pages
through the same hooks as everything the API serves, so serving them from
elsewhere one day changes the data layer and no page. Their labels, artists
and titles are the ones the data generator writes into the database, with
the same ids, and a test reads them from the generator itself: the fan
campaigns of §14.2 aim at these artists' listeners.

## Checks

```
npm run check -- --only site-types,site-codegen,site-unit,site-build,site-e2e
npm run e2e -w site
```

| Suite | What it checks | Floor |
|---|---|---|
| `site-types` | `tsc` over the pages and components as Next.js builds them, then over what Node runs | 30 and 21 files |
| `site-codegen` | every operation validates against the public schema, and the generated types equal a fresh generation | 10 operations |
| `site-unit` | the transport, the headers and errors of the API, request ids, dates across the clock change of 25 October, the drawings, the build's correction, the editorial catalogue against the generator | 42 tests |
| `site-build` | the static export, every page in it, the API it calls written in | 4 pages |
| `site-e2e` | the whole system and a headless Chromium, below | 7 tests, 9 audit events, axe on 7 pages |

`site-e2e` starts the engine on a clock the test moves, the gateway and the
site's build, launches the Student Autumn Pass through the console's API
(the console of stage 4 takes this part when the two are joined), and moves
the engine's clock past 09:00 in Rome on 26 October, the morning after the
clocks go back. It measures how long the engine takes to publish the pass
and how long an open page takes to show it. A student who has not verified
yet then enters as a demo listener, is verified by the simulated provider,
subscribes at 2,99 € a month for 3 months, then 5,79 €, and sees the first
month settle with a demo receipt; a student who paid before is told the pass
is not for them. The audit log must hold every step with the request id that
caused it, the browser's own for the student's, and its chain must hold. axe
runs on every page and state (no serious or critical violation), and no page
may ask another host for anything.

One run on 24 October 2026, on a Windows virtual machine with 8 CPUs and
12 GB shared with other work (so under load, not a benchmark): the engine
published the pass 0.1 s after 09:00, the open page showed it 8.0 s after
(it asks every 10 s), the first month was paid 0.1 s after the confirmation,
9 audit events, axe on 7 pages with no violation.

The end-to-end test needs Playwright's Chromium for playwright 1.62.1; the
check reports the suite as not run, never as passed, when it is missing.

## Notes

- **Next.js 16.4.0 and its advisories.** Three advisories published on
  22 October 2026 affect Next.js 16.0.0 to 16.4.0: a denial of service through
  Server Actions, code execution in the image optimization API with SVG files,
  and code execution in `use cache` functions returning typed arrays. The site
  uses none of them: it is a static export, with no Server Action, no image
  optimization (`images.unoptimized`) and no `use cache`; only `next dev` runs
  a server, on 127.0.0.1. The fixed 16.4.1 came out on 14 October, under the
  project's rule of dependencies at least two weeks old; the site moves to it
  before publication. The build's own check of the advisories, which calls the
  npm registry and stops the build, is off (`experimental.agentUpgrade`), so
  builds stay offline and reproducible.
- **The static export on Windows.** Next.js 16.4.0 writes the prefetch data
  of nested routes under a folder (`campaign/__next.campaign/__PAGE__.txt`)
  instead of the dotted name the router asks for
  (`campaign/__next.campaign.__PAGE__.txt`): the path it renames is joined
  with backslashes. `scripts/segments.ts` moves the files into place after
  every build; on Linux it finds nothing to move.
- **Not yet here.** The plans page in its final design, the listening
  sessions and the page that plays one (silently, said to be simulated) wait
  for the next round of the mock-ups. The gift pass and the German consent
  to a price rise come with stage 7.
