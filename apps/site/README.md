# Site

The public site of the fictional music service (Rione, a provisional name):
records from small labels and their listening sessions, the promise to the
artists, the plans and their prices in each market, the campaigns on sale,
the prepaid pass to give, and the journey of a demo listener who checks as a
student, subscribes at the price the engine quotes, answers a price change,
and finds it all in their account. It is a static
Next.js build: HTML, CSS and JavaScript that any web server can serve, with
every figure asked for by the browser from the gateway's public API.

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

## In the demo's sandbox (stage 8)

Built with `SANDBOX=1`, the same site runs in the demo in the browser, with
no server behind it: its requests go to the sandbox's worker, which runs the
engine's own Python code over PGlite and the gateway's core, once for every
tab of the address. The site opens the worker through the sandbox package's
client, the one the console opens too; `src/data/sandbox.ts` adds what is
the site's: what it reads again, and a transport that says a worker that
failed as an API out of reach. Nothing above the transport changes: the
pages, the hooks and the operations are the ones the full system serves.
What the engine's jobs changed is read again when the worker says so, and
when the demo starts over every tab reloads.

The first visit waits a few seconds while the database, Python and the
engine start on the visitor's device: a bar under the header shows the
worker's own steps, and the page is there meanwhile, the records and the
sessions at once and the figures as they come. If the browser cannot run
the demo (no WebAssembly, no IndexedDB, a private window that refuses the
storage), the bar says so and what to do. At the foot of every page, the
line on where the data stays and where the full system and its source are,
and the panel about the sandbox with Start over, in the words the console
uses too (`SANDBOX` in `packages/design`). Every page carries
`<meta name="robots" content="noindex">`.

```
npm run demo:build      # the site, the console and the sandbox, assembled in dist/demo/
npm run demo:serve      # dist/demo/ on http://127.0.0.1:4651
npm run photos -w site  # the photos of docs/images/, taken again from the demo
```

The site's journey in the demo, one run of the check's suite `demo` on
25 October 2026: a Windows 10 virtual machine with 8 cores of an Intel Core
i7-10700 and 12 GB, shared with other work, so under load and not a
benchmark; headless Chromium 151 with one browser profile, the demo served
from `dist/demo/` on 127.0.0.1, with no throttling. A first visit from an
empty browser had the home ready in 5.3 s, the worker's steps shown
meanwhile; a second tab was ready in 0.6 s. From another tab, a Student
Autumn Pass written, signed and scheduled through the console's API, then
the skip to its launch: the worker moved its clock, ran the launch's five
steps and answered in 2.6 s, and the site's open tab showed the campaign at
the same moment, 2.6 s after the skip. A reload had the home ready in 4.9 s; with every tab closed, the
worker started again on the data it kept in 5.1 s; Start over put every tab
back as the demo was built in 6.3 s. axe on 2 pages with no violation, and
no request left the address. The summary of the run, with the machine and
the conditions, is `reports/demo-site.json`.

## Pages

| Page | What it shows |
|---|---|
| `/?market=IT&plan=individual` | The home. It opens on music: a record of the market's label printed large, its liner note, and that label's listening session. Then the promise to the artists, one sail per paid plan with the minimum as a cord; then the plans, the chosen one open on where its money goes, what it includes and the way to take it, with a flag on each plan that has a campaign on sale; then the labels' new records and their listening sessions; last, while one is on sale, the prepaid pass to give, with its demonstration purchase. The market and the plan are in the address; a listener who has entered sees their own market |
| `/campaign/?market=IT&offer=42` | One campaign as the engine published it: its months drawn as sails, the price struck through and the offer price, the promise to the artists from the engine's breakdown of the offer price, and the steps of taking it |
| `/session/?label=casa-lenta` | A label's listening session, simulated: the running order, the lengths, the position, play and pause, the previous and next record. Nothing plays, and the page says so next to the button: play moves a clock. A record's time is split evenly among its tracks, which have no titles |
| `/account/` | The demo listener's plan, price, months left at an offer's price, the day the full price starts, the day a paid plan ends, the student check, and the first month's payment with its demo receipt. Then a price change of the plan, asked or told; the prepaid codes bought, with their state; and the way to activate a code |

A campaign page exists if and only if its offer is on sale (business book
§7.5): asked for one that is not, it says so. An open page asks for the
offers on sale every 10 seconds, so a launch shows up without a reload. The
home asks for the plans of the other markets once its own are shown, so
changing market shows prices at once.

Every figure on the promise and on "Where your € goes" is the engine's
breakdown of the plan's price (`Plan.breakdown`) and the market's minimum
(`Market.artistsMinimum`); the counts in a plan's line ("Two accounts, one
bill") are the plan's own entitlements. A listener of another market who
chooses a plan is told that a listener subscribes at their own market's
prices, with a way to them, before any quote is asked.

## A price change, asked or told (§8, §14.3)

When a price migration starts, the engine asks or tells every paid
subscriber of the plan in the market, by the law of the market, and the
account shows it. In Germany it is a request for consent: two answers side
by side with the same look and the same width, each with what follows from
it; the two futures drawn on the same rope; "If we don't hear from you by
17 December 2026, we take it as a no" written in so many words. In Italy,
France and the United Kingdom it is a notice: the new price and the day it
applies, and the way to leave before it; a notice asks for no yes. Every
date comes from the engine (`appliesFrom`, `ifNoLeavesOn`, `leavesOn`,
`newPriceFrom`, `Subscription.endsOn`): the site computes none. The law
(`legalBasis`, with its sources) and the service's commercial choice
(`ifNoAnswer`) stand in two blocks, the choice marked as not a legal
requirement. Once answered, the panel says what will happen and from when,
and an answer given is not asked again.

## The prepaid pass (§9, §14.4)

The home shows the pass only while one is on sale; in a market where none
is, it says where one is sold, and the header offers the way to it only
then. Buying is a demonstration in steps, like a subscription: the entrance,
the confirmation with the disclaimer, then the code. The code comes back
pending; the page reads the account every second, for thirty seconds at
most, until the simulated provider settles the payment, and only then shows
the code as one that works. The account lists the codes the listener
bought, and takes a code, bought or given: activated, it gives the pass's
months of its plan from that day, never charged and never renewed, then
Free. A code is like money: it reaches only the browser of the listener who
bought it, it is never in an address or a log line of the site, and the
end-to-end test holds that neither the engine nor the gateway logged it. A
code typed in the wrong shape is said at once and never sent.

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

## The drawings

Two kinds of picture, kept apart. Money is drawn as silk: translucent sails
of madder, saffron and indigo tied along a rope, whose lengths are the
amounts and whose overlaps show the chord of two dyes, as on the promise,
the canopy of a price and the months of an offer. Everything else is drawn as
print: each record's cover is generated from its seed in its label's
technique (a linocut for Casa Lenta, a pochoir for Disques Pareil, a
scraperboard for Kellerlicht, a cyanotype for Coldframe Records), so the same
seed draws the same cover on every machine, and a test holds each cover to its
fingerprint. The geometry is pure functions (`src/components/art`), so tests
hold the drawings to the figures they stand for. No picture comes from
outside the repository.

The courtyard behind the pages is one stretch of white flagstones
(`src/app/courtyard.svg`, written by `scripts/courtyard.ts` from a seed),
centred under the page; on a screen wider than the stretch it fades into
plain stone towards the sides, so its repeat does not show.

## Motion

Little moves, and only for a reason. Changing market cross-fades the record
of the opening (220 ms); the plan that opens and the steps of a subscription
come in with a fade from 4 px above (220 ms). A button gives under the
press. Nothing moves while the visitor uses the
keyboard (`html[data-input="keyboard"]`, set by the input watcher), and with
reduced motion every entrance is a 140 ms fade. The listening session
changes in place, as a player does: its clock, buttons and running order
never animate.

## Checks

```
npm run check -- --only site-types,site-codegen,site-unit,site-build,site-e2e,site-e2e-7
npm run e2e -w site                 # both end-to-end tests, one after the other
npm run e2e -w site -- gift         # stage 7's alone
```

| Suite | What it checks | Floor |
|---|---|---|
| `site-types` | `tsc` over the pages and components as Next.js builds them, then over what Node runs | 48 and 39 files |
| `site-codegen` | every operation validates against the public schema, and the generated types equal a fresh generation | 14 operations |
| `site-unit` | the transport, the headers and errors of the API, request ids, dates across the clock change of 25 October, the drawings (the promise, the sheets of a price, the covers' fingerprints), the clock of a listening session, the plans' order and lines, a prepaid code as typed, a pass's months and a period's sheet, a price change's sentences, the build's correction, the editorial catalogue against the generator, the readings of `me` cancelled on an entry or an exit, the tab and the sandbox's worker over their protocol (with a fake worker), a worker that failed said as an API out of reach | 84 tests |
| `site-build` | the static export, every page in it, the API it calls written in | 5 pages |
| `site-e2e` | the whole system and a headless Chromium, stage 5's journey, below | 9 tests, 9 audit events, axe on 9 pages, 20 pages fitted |
| `site-e2e-7` | the same for stage 7: a gift pass bought and activated, a request for consent in Germany answered, a notice in Italy, below | 9 tests, 5 audit events, axe on 9 pages, 10 pages fitted |
| `demo` | the assembled demo served on 4651, headless Chromium with one browser and its tabs: the first start, a second tab, a campaign launched from another tab reaching the site, the data after a reload and after the worker started again, Start over in every tab; no request leaving the address, axe | 6 tests for the site |

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
caused it, the browser's own for the student's, and its chain must hold. A
verified student then takes the pass from the home on the keyboard alone,
with nothing moving while they do. The home, the campaign, a listening
session and the account are loaded at 1440, 1280, 720 (1440 at 200 %), 390
and 320 pixels, and none may scroll sideways or cut off a line of text. axe
runs on every page and state (no serious or critical violation), and no page
may ask another host for anything.

`site-e2e-7` starts the same system on a database of its own. The
commercial lead's gift pass is launched through the console's API, and the
open home shows it; a listener in Italy buys a code, waits for the simulated
payment and gets the demo receipt; another listener activates the code and
has three months of Individual, never charged, then Free; a third cannot use
it again, and the code is in no line the engine or the gateway logged. Two
price migrations follow, Family in Germany and Individual in Italy: the
Family subscriber in Germany is asked, with two answers of the same weight,
and says no; the Individual subscriber in Italy is told, and leaves before
the new price; each sees the engine's dates. The audit log holds each
listener's step with the request id their browser sent.

One run on 24 October 2026, on a Windows virtual machine with 8 CPUs and
12 GB shared with other work (so under load, not a benchmark): the engine
published the pass 0.2 s after 09:00, the open page showed it 6.0 s after
(it asks every 10 s), the first month was paid 0.2 s after the confirmation,
9 audit events, axe on 9 pages with no violation, and 20 pages fitted at the
five widths. The same day, `site-e2e-7`: the pass on the open page 10.1 s
after its start (the page asks every 10 s), the code ready 0.3 s after the
purchase, 5 audit events, the code in no log line, axe on 9 pages with no
violation, 10 pages fitted.

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
