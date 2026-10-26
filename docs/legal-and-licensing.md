# Legal and licensing review

Written on 25 October 2026 by the author, who is not a lawyer. It records what
was checked, with sources and dates, and what is still open. It is not legal
advice, and a commercial launch would need a professional review of every
section.

## Names and trademarks

Plancia (the platform) and Rione (the fictional streaming service) are
provisional names. They were chosen in place of the working names Box Office
and Encore, both already in use near this field, and they will be confirmed or
replaced before the repository is published.

What was checked for the provisional names, on 24 October 2026: national
registers and trade-mark search engines reachable without an account, the
software and music services with similar names, visual and phonetic
similarity, the relevant classes (9 and 42 for software, 41 for music
services), and domain names, which say nothing about trade-mark rights. Rione
showed only composite marks in class 41 and unrelated apps: a low risk.
Plancia is close to PLANIA, an EU trade mark filed in 2024 in classes 9 and
42, so its risk is rated medium. A negative search does not
guarantee that a name is free to use; a name meant for commercial use needs a
clearance search by a trade-mark professional.

The interface takes nothing from existing platforms: no marks, logos or
proprietary icons, no recognisable colour scheme or layout of a known
product, and no wording that suggests an affiliation, a sponsorship or a
commission. The names of real streaming services appear nowhere in the
repository, its history or the interface; the author's publishing check,
kept outside the repository, searches the files, the history and the commit
messages for them, and stops the publication when it finds one.

## Assets

Every image in the interface is drawn by the project, except the icons, which
come from Phosphor under the MIT licence.

| Asset | Where | Author | Licence | Obligations |
|---|---|---|---|---|
| Archivo, the display typeface | `packages/design/fonts` | The Archivo Project Authors (Omnibus-Type) | SIL Open Font License 1.1 | keep the licence beside the font files (done); do not sell the fonts on their own |
| Atkinson Hyperlegible Next, the text typeface | `packages/design/fonts` | The Atkinson Hyperlegible Next Project Authors | SIL Open Font License 1.1 | as above |
| Icons | `packages/design/src/icons.ts`, copied from `@phosphor-icons/core` 2.1.1 | Phosphor Icons | MIT | keep the copyright notice (`packages/design/src/LICENSE-phosphor.txt`) |
| Record covers | drawn at run time by `apps/site/src/components/art/covers.ts` from each record's seed | the project | Apache-2.0, as the code that draws them | none |
| Courtyard texture | `apps/site/src/app/courtyard.svg`, a generated pattern | the project | Apache-2.0, with the site's code | none |
| Wordmarks of Plancia and Rione | the names set in Archivo by the interface's code | the author | not licensed: reserved ([TRADEMARKS.md](../TRADEMARKS.md)) | none; not registered |
| Screenshots in the README | `docs/images`, taken from the project's own builds, with synthetic data | the author | not licensed: all rights reserved ([TRADEMARKS.md](../TRADEMARKS.md)) | none |

No stock photography, no images found on the web, no screenshots of other
products. Artists, labels, albums and people are invented, and their names
were searched to avoid matching real artists.

## Software licences

`npm run licenses` reads four inventories and checks every package against
the policy below, and `npm run check` fails when a package falls outside it.
The inventories are npm's lockfile, the engine's Python environment, the
files `npm run setup` downloads, and what the sandbox serves besides its npm
packages (two Python wheels, and the CPython standard library inside
Pyodide). On 25 October 2026, on Windows: 586 packages, none outside the
policy (one fewer on Linux, where pytest does not need colorama).

The demo carries the notices of the third-party code it serves:
`THIRD-PARTY-NOTICES.txt`, at the root of `dist/demo` and linked from the
sandbox's About panel, gives each package its version, licence and licence
text. The demo's build writes it (`tools/licenses.ts`; `npm run licenses`
writes a copy in `reports/`) and fails when something the demo serves has no
entry in it.

Permissive licences are allowed wherever a package ends up, with its notice
kept: MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0,
Python-2.0, PSF-2.0, Unlicense, CC0-1.0, Zlib, PostgreSQL and OFL-1.1.
MPL-2.0, a file-level copyleft, is allowed for files used unmodified. It
covers build and test tools (lightningcss, axe-core, Hypothesis) and, in the
browser sandbox, Pyodide, whose files are served as they are published.

Three exceptions are named, each with the reason it never reaches what the
project distributes: the libvips binaries (LGPL-3.0-or-later) that Next.js
installs for an image optimizer the static exports never use; the
browser-support data of caniuse-lite (CC-BY-4.0), read only by build tools;
and the Eclipse Temurin Java runtime (GPL-2.0 with the Classpath Exception),
which Flyway runs on as a separate program, downloaded into `.tools` by the
setup. Anything else fails, including a package that declares no licence.

Flyway's jars carry no machine-readable licence. The one recorded is what
`flyway-parent` 13.10.0 declares on Maven Central (Apache-2.0) and, for the
other jars, what their own licence files and manifests say.

### The repository's own licence

The code and the documentation are under the Apache License, Version 2.0,
chosen by the author on 26 October 2026 among MIT, Apache-2.0 and AGPL-3.0.
Anyone may use, change and distribute the code, also commercially and also
as a service, without publishing their changes; they keep the licence and
the NOTICE, and say which files they changed. The licence adds an explicit
patent grant from each contributor, which ends for whoever sues over a patent
in the work. The project's NOTICE names what the repository holds under other
licences.

The licence covers copyright in the code, not the project's names, their
wordmarks or the images in `docs/images`, which stay the author's
([TRADEMARKS.md](../TRADEMARKS.md)): a fork may take the code, not the name.

Every dependency allows it, as far as the licence check can tell: all of
them are under the permissive licences above or under MPL-2.0 used unmodified,
and the three exceptions never reach what the project distributes. A lawyer
should confirm it before any commercial use.

## Privacy and data

The full system holds no personal data: every subscriber, listener and
member of staff is generated. Signing in with a role sets one technical
session cookie per API (HttpOnly, SameSite=Strict), kept in the gateway's
memory and gone when it restarts.

The browser sandbox runs entirely in the visitor's browser. It stores its
database in the browser's IndexedDB for the sandbox's own address; the
"Start over" command deletes it and starts again from the build's data, and
clearing the site's data in the browser deletes it too. Nothing typed in the
sandbox leaves the browser: there is no account, no form that sends anything,
no analytics, no advertising, no third-party script or font, and the tests
refuse and count every request to another origin. The web server that hosts the static files still records
each request in its access logs (address, time, page, browser), as any web
server does, so the sandbox is not anonymous in an absolute sense. Adding
analytics, real accounts or non-technical cookies would need a privacy
assessment first.

## Payments

No payment is real. The site says so on every page, with two labels at the
top and a sentence in the footer, and in full next to each step that could
pass for a purchase ("Independent personal project. Fictional business and
synthetic customer data. No real payments are processed."); its buttons say
demo ("Confirm demo subscription", "Confirm the demo purchase"), and any
receipt is marked as a demonstration. A simulated payment provider sits
behind an interface: its events are counted once even when they arrive twice
or out of order, and a real provider would plug in at that interface.

Prices, discounts, durations, renewals, currencies, eligibility,
entitlements and price versions are computed for real, because that is the
product. Taking real money would need, at least: a payment provider and its
contract, invoices with legal value, tax registration and reporting beyond a
market's VAT rate, and a review of consumer protection (including withdrawal
rights and renewal notices) and of payment regulation in each market.

## Market rules

The business book keeps three kinds of rule apart, and the code models them
apart:

1. A legal obligation is stated with its source, territory, date and limits.
   VAT rates per market are dated and cited ([business.md §3](business.md#3-markets-vat-time-zones-and-reporting));
   the German requirement to ask existing subscribers for consent before a
   price increase rests on two judgments of the Kammergericht of 15 November
   2023, made final in 2025, and on a judgment of the Bundesgerichtshof of
   1 October 2026, cited by court and date
   ([business.md §8.2](business.md#8-price-changes-for-existing-subscribers)).
   These rulings concern price-change terms in consumer subscriptions; they
   are not treated as a rule for every platform or contract.
2. A commercial policy of the fictional service is configurable per market:
   what happens to a German subscriber who does not consent (today: the Free
   plan when the period already paid runs out), notice lengths in Italy,
   France and the United Kingdom, the artists' guaranteed minimum, the
   finance threshold ([business.md §8.6 and §16](business.md#16-assumptions-in-one-place)).
3. A simplification of the demonstration: the demo's listeners who answer a
   consent request and a simulated student verification, in both modes, and
   in the sandbox its own clock and a simulated fault.

None of this is a statement of legal compliance in any market.

## Open points

| Point | Status | Needs |
|---|---|---|
| Final names of the platform and of the fictional service | open | the author's choice, then a professional clearance search before any commercial use |
| The repository's licence | Apache-2.0, chosen on 26 October 2026; names and images reserved (TRADEMARKS.md) | closed |
| Next.js 16.4.0 security advisories (22 October 2026) | closed: Next.js 16.4.3 since 26 October 2026 | none |
| Access logs of the host that will serve the sandbox | known | a line in the host's privacy notice at publication |
| Commercial launch | out of scope | tax, consumer, payment and privacy review per market |
