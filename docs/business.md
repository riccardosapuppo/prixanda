# The Rione business book

Plancia is a subscription and pricing operations platform: it decides what
a subscription business sells, to whom, at what price, from when, and with
whose sign-off, and publishes those decisions safely. This book describes the
business the platform is explored through. Rione is a subscription music
service for independent music, and it is fictional: the company, its people,
artists, releases, subscribers and numbers are invented, and every figure
the product shows comes from a deterministic data generator. The rules the
book states are the ones the platform really applies: they are what the code
and the tests are measured against.

Three things are kept apart throughout: what a law requires, with its source,
territory and date; what Rione, a fictional company, decides as a commercial
policy; and what the browser sandbox simplifies. A rule of the first kind is
never presented as general legal compliance.

Every feature of the product points to a paragraph of this book (written as
§ and a number). A feature that answers no paragraph is not built.

*Rione and Plancia are provisional names: the definitive ones are chosen and verified before publication.*

## 1. What Rione is

§1.1 **The service.** Rione streams music from independent labels and
self-released artists in four markets: Italy, France, Germany and the United
Kingdom. Next to the music it publishes editorial work: release notes, short
stories about the people behind a record, and curated listening sessions.
The product in this repository does not play audio: it covers how the
service is sold and governed.

§1.2 **The promise to artists.** For every paying subscription, every month,
Rione pays into the artists' pool at least a guaranteed minimum (§5.3),
whatever discount the subscriber is on. This promise is the reason every
price has a floor, and the reason a promotion below that floor needs
finance's signature (§7.3).

§1.3 **Who uses Plancia.** Six roles (§12) run Rione's commercial side.
They need to launch offers quickly without breaking three things: revenue,
the trust of subscribers (no surprise charges, no unclear price rises), and
the promise to artists.

## 2. Plans and what they include

§2.1 The catalog manager defines plans and their entitlements. A plan is a
set of entitlements; its prices live in the price list (§4), not in the plan.

| Plan | Paid | Seats | Skips | Audio quality | Offline | Notes |
|---|---|---|---|---|---|---|
| Free | no | 1 | 6 per hour | standard (160 kbps) | no | |
| Individual | yes | 1 | unlimited | lossless | yes | |
| Duo | yes | 2 | unlimited | lossless | yes | |
| Family | yes | 5 | unlimited | lossless | yes | |
| Student | yes | 1 | unlimited | lossless | yes | needs a valid student verification (§10) |

§2.2 Entitlements are data, versioned like everything else: changing what a
plan includes is a change that goes through approval (§7).

## 3. Markets, VAT, time zones and reporting

§3.1 **Markets.**

| Market | Currency | Minor units | Time zone | VAT (standard) |
|---|---|---|---|---|
| Italy | EUR | 2 | Europe/Rome | 22% |
| France | EUR | 2 | Europe/Paris | 20% |
| Germany | EUR | 2 | Europe/Berlin | 19% |
| United Kingdom | GBP | 2 | Europe/London | 20% |

§3.2 **Prices include VAT; revenue does not.** Consumer prices are shown and
charged including VAT (Consumer Rights Directive 2011/83/EU, art. 6(1)(e);
in the United Kingdom, Consumer Contracts Regulations 2013, Schedule 2). For
electronically supplied services sold to consumers, VAT is due in the
customer's country (VAT Directive 2006/112/EC, art. 58(1)(c) and Annex II,
which lists the supply of music; United Kingdom: VAT Act 1994, Schedule 4A,
para. 15). Rione assumes the customer-country rule always applies; the
exception of art. 59c of the Directive (a supplier established in a single
EU Member State with cross-border sales up to EUR 10,000 a year) is not
modelled.

§3.3 **Rates are dated configuration.** The standard rates above were
checked on official sources on 24 October 2026. None of the four markets has
a reduced rate for on-demand music streaming: in the EU, reduced rates are
limited to the categories in Annex III of the VAT Directive (art. 98(1)),
and HMRC's list of reduced and zero rates does not include it. Each rate is
stored with the date it takes effect, never as a constant. To re-check
before publishing: Italy replaces its VAT decree with a consolidated VAT code
from 1 January 2027 and France moves its VAT rules into a new tax code from
the same date (no change to the standard rates was found); the United
Kingdom presents its Budget on 28 October 2026.

§3.4 **Money is an integer.** Every amount is an integer number of the
currency's minor unit (cents, pence), stored with its currency. Divisions
round half up to the minor unit, and the rule is written in one place. The
engine is also tested on a currency without decimals (Japanese yen), which
Rione does not sell in, so that nothing assumes two decimals.

§3.5 **Net of VAT.** For a price `P` including VAT and a rate `v` in basis
points (2200 is 22%), the net amount is

    N(P) = round_half_up(P × 10000 / (10000 + v))

Example: an Italian Student subscription at €5.79 has a net amount of
€4.75 (579 × 10000 / 12200 = 474.59, rounded to 475 cents).

§3.6 **Reporting in euros at a declared rate.** Reports are in EUR. GBP
amounts are converted at a declared rate stored with each report. The
reference rate used in this book and in the generated data is the ECB euro
foreign exchange reference rate of 23 October 2026: 1 EUR = 0.83728 GBP
(1 GBP is about 1.194344 EUR). The ECB publishes these rates for information
purposes only; using it is a reporting choice of Rione, not a legal
requirement. Example: £9.49 is reported as €11.33.

§3.7 **Local time.** Anything scheduled for a market (an offer starting, a
price taking effect, a consent deadline) is stored as a local time with the
market's time zone, and converted to an instant only when it is evaluated.
"09:00 in Italy" stays 09:00 in Italy across a daylight-saving change; on 25
October 2026 the clocks go back in all four markets, and a test crosses that
night.

## 4. The price list

§4.1 The commercial lead owns the price list: one price per plan, market and
period of validity. Periods are half-open, from a local start (included) to
a local end (excluded) or open-ended. The database refuses two prices for
the same plan and market whose periods overlap.

§4.2 **A price in force is never edited.** To change a price, a new price is
created with a later start; the current one gets an end. History stays
readable: on any date, the price that applied is the one whose period
contains it.

§4.3 **Existing subscribers keep their price.** A subscriber pays the price
they subscribed at until a price migration moves them, under the rules of
their market (§8). New subscribers pay the price in force on the day they
subscribe.

§4.4 **Prices at the start of the data** (including VAT):

| Plan | Italy | France | Germany | United Kingdom |
|---|---|---|---|---|
| Individual | €10.49 | €10.99 | €10.99 | £9.49 |
| Duo | €14.49 | €14.99 | €14.99 | £12.99 |
| Family | €17.99 | €18.49 | €18.99 | £16.49 |
| Student | €5.79 | €6.49 | €5.99 | £5.29 |

§4.5 **The price is always the engine's.** A browser never sends a price.
The site asks the engine for a quote (plan, market, offer), shows it, and
confirms the quote by its identifier; the engine charges what it quoted. A
quote expires; a quote for an offer that ended is refused. The engine
decides a confirmation at the moment it holds what it decides on: the quote
must not have expired by then, and the offer must still be active and cost
less than the list price in force at that moment.

The subscription starts when the quote is confirmed, and its first month is
charged after the confirmation is recorded, never inside it: the payment
provider is asked through the outbox (§7.5), and its answers settle the
payment. Each answer counts once, however often and in whatever order it
arrives; the receipt is issued when the payment succeeds. If the provider
declines the charge, the paid subscription ends at the end of that day and
the listener is back on the free plan the next day. The provider is
simulated and accepts every charge (§15).

## 5. The artists' economics

§5.1 **Net revenue.** Revenue is counted net of VAT (§3.5), per paying
subscription and per month.

§5.2 **The artists' pool.** Rione pays rights holders a share `s` of net
subscription revenue. In this book and in the generated data `s` is 60%
(an assumption, editable in Plancia's settings):

    pool(N) = round_half_up(N × s)

§5.3 **The guaranteed minimum.** For every paying subscription, every month,
the artists' pool receives at least `G`: €3.00 in the euro markets and £2.60
in the United Kingdom. When the share of a subscription's net revenue is
below `G`, Rione tops it up from its own margin:

    top_up(N) = max(0, G − pool(N))
    owed_to_artists(N) = pool(N) + top_up(N) = max(pool(N), G)

A prepaid pass (§9) counts as a paying subscription for every month it
covers. The Free plan pays nothing and is outside the guarantee.

§5.4 **The floor.** The floor of a market is the lowest price, including
VAT, whose pool covers the minimum without a top-up. The engine finds it by
the formulas above, so rounding is included:

| Market | Floor |
|---|---|
| Italy | €6.10 |
| France | €6.00 |
| Germany | €5.95 |
| United Kingdom | £5.19 |

§5.5 **A standing exception.** The Italian Student price (€5.79) is below
the Italian floor. Its net amount is €4.75, its pool €2.85, so Rione adds
€0.15 per Student subscription per month. This was a deliberate acquisition
choice, approved by finance as a standing exception; Plancia shows its
running cost on the price list.

§5.6 **Payment costs.** Collecting money costs a share `f` of gross receipts
(including VAT). In this book `f` is 1.8% (an assumption; the payment
provider is simulated, §15).

§5.7 **Contribution of a subscription-month.**

    contribution = N − owed_to_artists(N) − f × P

## 6. Offers and campaigns

§6.1 **What an offer is.** An offer is a versioned document. Each version
states:

- the audience: who may take it (market, current plan or none, new or
  existing subscribers, student verification, listening behaviour);
- the price per market, as a fixed amount or a percentage off the list price
  in force, rounded to the currency's minor unit;
- the duration: how many billing months at the offer price, and what happens
  after (the list price in force at that time);
- the period during which it can be taken, in each market's local time;
- the non-combinability group: offers in the same group never stack, and a
  subscriber holds at most one of them;
- an optional cap on redemptions, per market or overall;
- the page: title, short text, terms, and the editorial treatment of its
  campaign page.

§6.2 **The struck-through price is the real one.** When the site shows a
price struck through next to an offer price, it is the list price in force
in that market on that day, read from the price list, never typed in the
offer.

§6.3 **Drafts and revisions.** A draft has a revision number. Saving over a
revision that someone else has already superseded is refused with a
conflict, and the response carries the newer version, so nobody silently
overwrites a colleague.

§6.4 **Validation before approval.** A version can be submitted only after
validation, which checks:

- the price per market against the floor (§5.4);
- overlaps and conflicts with other offers for the same audience and period;
- dates and time zones (a start before the end; a start in the future);
- that the audience is consistent (for example, Student offers need student
  verification; existing-subscriber offers need a plan);
- that every market has its page text;
- and which signatures the version needs (§7.3).

Two offers conflict when they are in the same non-combinability group, sold
in the same market in periods that overlap, to audiences that can hold the
same person. The definitions answer that last question (people who never
paid and Free listeners can be the same people; subscribers of two different
plans cannot; a student check or a listening threshold only narrows an
audience), except when both audiences ask for listening to an artist, a
different one each. The same person can listen to both, so the engine counts
in the data how many people are in both audiences, in that market, on the
day of the check. More than zero is a conflict, and the number is in the
validation's report and in the refusal; a count that cannot be made is a
conflict too. Scheduling and activation check the conflict again, and count
again. Someone who comes to be in both audiences once both campaigns are
live is still protected one by one: a subscriber holds at most one offer of
a group, and confirming a quote for a second one is refused with
NOT_COMBINABLE (§10.3).

§6.5 **The difference, in business words.** Before anyone approves, Box
Office states the change as a sentence, in this shape: "Italy, Student: from
€5.79 to €2.99 for 3 months, new subscribers only; N eligible; conflicts:
none." N, the number of eligible people, is counted in the data when the
sentence is written, never typed by the author.

§6.6 **The simulation of a campaign.** A campaign is compared with not
running it, over a horizon of `H` months. An offer that lasts longer than
`H` months is simulated over its own months and then `H` months after them,
so that the simulation always covers the whole offer. The assumptions are
visible and editable, and each one carries its source (a default from this
book, or a value someone typed, with their role and the time):

- `E`: the eligible audience (from the data);
- `u`: take-up, the share of `E` that takes the offer;
- `i`: the incremental share, takers who would not have subscribed without
  the offer; the rest, `1 − i`, would have subscribed at the list price;
- `r`: retention, the share of takers who stay at the list price after the
  offer;
- `d`: months at the offer price; `P_o` and `P_l`: offer and list price.

With `T = round(E × u)` takers, `R = round(T × r)` stayers and
`C = T − round(T × i)` cannibalized subscribers:

    revenue_with    = T × d × N(P_o) + R × (H − d) × N(P_l)
    revenue_without = C × H × N(P_l)
    artists_with    = T × d × owed(N(P_o)) + R × (H − d) × owed(N(P_l))
    artists_without = C × H × owed(N(P_l))
    fees_with       = f × (T × d × P_o + R × (H − d) × P_l)
    fees_without    = f × (C × H × P_l)

    Δ revenue  = revenue_with − revenue_without
    Δ artists  = artists_with − artists_without
    Δ fees     = fees_with − fees_without
    Δ margin   = Δ revenue − Δ artists − Δ fees

It also reports two costs that finance asks about by name:

    discount_cost = C × d × (N(P_l) − N(P_o))     revenue given up on people who would have paid
    top_up_cost   = T × d × top_up(N(P_o))        what the artists' minimum costs Rione

The simulation states its assumptions next to its results. It does not
learn anything from data and makes no forecast beyond these formulas.

§6.7 **A worked example.** An illustrative Student offer in Italy: €2.99 for
3 months instead of €5.79, horizon 12 months, `E` = 10,000, `u` = 12%,
`i` = 60%, `r` = 55%. Then `T` = 1,200, `R` = 660, `C` = 480; the offer's net
amount is €2.45 with a pool of €1.47 and a top-up of €1.53 per month.

| | With the offer | Without | Difference |
|---|---|---|---|
| Net revenue | €37,035.00 | €27,360.00 | €9,675.00 |
| Owed to artists | €28,620.00 | €17,280.00 | €11,340.00 |
| Payment costs | €812.82 | €600.31 | €212.51 |
| Contribution | | | −€1,877.51 |

Discount cost €3,312.00; top-up cost €5,508.00. The offer loses money over a
year with these assumptions; it is a choice to buy subscribers, and the
negative contribution is one of the reasons it needs finance (§7.3).

## 7. Approvals

§7.1 **States.** A change (an offer, a price, a plan's entitlements, a price
migration) moves through: draft → validated → in approval → approved →
scheduled → active → ended. A rejection sends it back to draft with the
reason. An active change can be suspended, and a scheduled one cancelled;
both need a reason. Every transition writes its audit event in the same
transaction as the change (§11).

§7.2 **Approval is bound to a version.** An approval names the exact version
and the fingerprint of its content. Editing a version creates the next one,
and approvals never carry over to it.

§7.3 **Who signs.** Every change needs at least one approval from someone
other than its author, in a role allowed to approve that kind of change.
Finance must sign when any of these is true:

1. a list price is created or changed;
2. an offer price is below the floor of its market (§5.4);
3. the simulated discount cost plus top-up cost over the horizon is above
   €20,000 (the threshold is a setting);
4. the simulated contribution over the horizon is negative; the author must
   then write why the campaign is still worth running;
5. a price migration asks existing subscribers to accept a higher price
   (§8).

Condition 4 also counts as met when, in a market, the simulated takers
round to zero (an audience too small for the assumptions: 1 eligible person
at 12% take-up is 0 takers). The simulation then shows no effect either way,
not even a loss, and an effect that cannot be shown is finance's to sign;
the author writes why, as for a negative contribution. This is a prudent
choice of this book, not a rule from elsewhere. For the same reason, when a
campaign cannot be simulated at all (no list price in force to compare
with, for example), conditions 3 and 4 both count as met: a simulation that
is missing never reads as a condition not met.

Otherwise the commercial lead or finance may approve.

§7.4 **Separation of duties.** The author of a version cannot approve it,
and one person cannot give two of the signatures a version needs. These
rules are enforced by the engine and again by the database, so a bug in one
layer does not open the door. Identities come from the server's session,
never from a field in a request. Plancia is designed around SOX-style
separation of duties and auditable approval controls; it is not certified
against any standard.

§7.5 **Scheduled activation.** An approved change starts at a local time in
each market (§3.7). Activation is a job that publishes the new catalog in a
single transaction, so the site shows an offer if and only if its prices are
in force. If activation fails halfway, nothing half-done is visible, and the
job resumes from where it stopped.

The job is a launch of five steps, each recorded with its times, attempts
and errors: check that the change is still the approved version and that
nothing stands in its way (a clash, §6.4, or a later price, §4.1); prepare
the new catalog; publish it, in the one transaction that also makes the
change active; tell the site, through an outbox that delivers the notice at
least once to a site that takes it once; and verify what the site now
shows. A step that fails is tried again after 5, 15, 45 and 135 seconds, and
a step that is done is never done again, so a launch publishes once however
often it resumes. After five failures in a row the launch fails; a check
that finds a clash or a later price refuses it at once. A failed or refused
launch opens an incident, and so does a scheduled change that is not live
five minutes after its start; the console's home counts them among today's
incidents. The on-call engineer retries the launch or cancels it, with the
change (§12); what to do, step by step, is in the runbook
(docs/runbook.md).

## 8. Price changes for existing subscribers

§8.1 **Two separate questions.** For each market Plancia keeps a policy
with two parts that are never mixed: what the law requires before an
existing subscriber pays more (the legal basis, with its source), and what
Rione decides to do when a subscriber does not accept (a commercial choice,
configurable).

§8.2 **Germany.** In two judgments of 15 November 2023, the Kammergericht
(Berlin) held that terms of streaming subscriptions letting the provider
raise the price at its own discretion, to pass on higher overall costs,
unreasonably disadvantage consumers (German Civil Code, § 307(1), first
sentence). The provider had no legitimate interest in such a term, because
it can ask subscribers to consent to a higher price, and the terms gave no
matching duty to lower the price when costs fall. Both terms already told
customers they could cancel before the change took effect, and were still
invalid. The Bundesgerichtshof (Federal Court of Justice) rejected the
providers' complaints against the refusal of leave to appeal on 30 January
2025 and 27 February 2025, so both judgments are final. On 1 October 2026
the Bundesgerichtshof also held a subscription's price-change terms invalid
because they did not make clear what rights the customer had when the price
rose.

Rione therefore asks existing subscribers in Germany for their active
consent before a price increase applies, and the request states plainly
what happens if they do not consent. Silence is never taken as consent.
What happens next is a commercial decision, configured per market, not a
legal consequence: the court noted that, without consent, the provider is
free to end the contract. Rione's current choice is to move the account to
the Free plan at the consent deadline, keeping playlists and library; ending
the paid subscription at the end of the billing period, or keeping the old
price until a stated date, are the other options.

§8.3 **Italy.** The Consumer Code (Legislative Decree 206/2005, art.
33(2)(m) and (o)) presumes unfair, unless the trader proves otherwise, a
term letting the trader change the contract unilaterally without a justified
reason stated in the contract, and a term letting the trader raise the price
without the consumer being able to withdraw when the final price is
excessively high compared with the agreed one. The Code's exception allowing
changes to indefinite-duration contracts with notice and a right to withdraw
(art. 33(3)) covers financial services only. Rione therefore states in its
terms the reasons that can justify a price change, gives advance notice, and
lets the customer withdraw before the new price applies. The Code sets no
notice period for this sector: the notice length, the list of reasons and
the absence of any exit fee are company policy.

§8.4 **France.** A term reserving to the trader the right to change
unilaterally the price of the service is prohibited in consumer contracts
(Consumer Code, art. R. 212-1, 3°). For contracts of indefinite duration,
the Code allows a term letting the trader change the price if the consumer
is informed within a reasonable time, so as to be able to terminate the
contract (art. R. 212-4). Rione therefore applies price increases to French
rolling subscriptions only after advance notice, with the option to
terminate before the new price applies. The length of the notice is company
policy.

§8.5 **United Kingdom.** The Consumer Rights Act 2015 lists as terms that
may be regarded as unfair those letting the trader alter the contract
without a valid reason specified in it (Schedule 2, para. 11) or raise the
price without giving the consumer the right to cancel (para. 15). The list
is indicative and non-exhaustive (section 63). The CMA's guidance on unfair
contract terms (CMA37, 22 July 2026) says a price-variation term is more
likely to be fair when, among other conditions, the consumer gets
sufficient and effective advance notice and is genuinely free to exit.
Rione therefore applies UK price increases only after advance notice, with
the option to cancel before the new price applies. This is not presented as
a legal safe harbour; the notice length is company policy.

§8.6 **Policy only, no source imposes it.** Plancia presents these as
Rione's settings, never as law: what happens to German subscribers who do
not consent; the length of the notice in Italy, France and the United
Kingdom (30 days in the generated data); the list of justified reasons in
Italy; reductions when costs fall, caps and frequency of increases; moving
non-accepting subscribers to the Free plan outside Germany; the notice when
Rione itself ends a rolling subscription.

§8.7 **What the simulation of a migration shows.** Who pays what and from
when (new subscribers from the start date, existing ones from their own
acceptance or notice date); the revenue at risk under an acceptance rate
`a` declared as an assumption; who would move to the Free plan; and the
prepaid passes that the change does not touch (§9). For the German Family
example: €18.99 to €20.99 raises the net amount from €15.96 to €17.64, and
the pool from €9.58 to €10.58, per accepting subscription per month.

## 9. Prepaid passes

§9.1 A prepaid pass is a different product: three months of Individual paid
in advance (€29.99 in Italy), sold as a single-use code that can be given
as a gift. It never renews and is not affected by price changes made after
it was sold.

§9.2 **Value sold and not yet earned.** Finance sees the value of passes
sold but not yet earned, by market. A pass's net amount is recognized in
equal monthly parts from activation, the last part taking the remainder: an
Italian pass, net €24.58, is recognized as €8.19, €8.19 and €8.20. Unused
codes stay unearned until they expire. This is the only accounting Box
Office does (§15).

## 10. Student verification

§10.1 A simulated verification provider confirms that a person is a
student. The provider sits behind an interface; a real one would plug in
there, and the product says that it is simulated.

§10.2 A verification is valid for 12 months. When it expires, the Student
price ends at the next billing date unless the person verifies again.

§10.3 Offers in the same non-combinability group never stack: a student on
a Student offer cannot add another Student offer, and the engine refuses it
with the reason.

## 11. The audit log

§11.1 **What an event holds.** Every change of state writes one event in
the same transaction as the change: who (the authenticated identity and its
role), what, the state before and after, when, why (the reason, when one is
required), and the request identifier. The identifier is born in the site
or the console and travels through the gateway and the engine to the log.

§11.2 **Append only.** The application's database role can add events and
read them; it cannot update or delete them, and a trigger refuses updates
and deletes for everyone.

§11.3 **The chain, and what it really guarantees.** Each event stores the
hash of the previous one and its own hash, computed by the database under a
lock, so events form one chain in one order. A command recomputes the chain
from the stored events. It detects an event changed, removed or reordered
after the fact. It does not prevent changes: an administrator of the
database can disable the trigger, rewrite events and recompute every later
hash. To catch that, the head of the chain is exported with each audit
export and kept outside the database; a chain that no longer leads to an
exported head has been rewritten. The log is tamper-evident against that
anchor, not immutable.

§11.4 The auditor reads and exports the log; nobody can change it through
Plancia.

## 12. The team

§12.1 The people of the demo are named by role, never by a person's name.

| Role | Can | Cannot |
|---|---|---|
| Marketing | create and edit campaigns, run simulations, submit | approve |
| Commercial lead | own the price list and commercial rules, create price changes, approve campaigns within the thresholds | approve own versions; sign for finance |
| Finance | approve price changes and anything over a finance condition (§7.3); read revenue and unearned value | approve own versions |
| Catalog manager | define plans and entitlements | approve own versions; change prices |
| On-call engineer | suspend an active change; retry or cancel a launch that stopped (roll back a launch) | create or approve anything |
| Auditor | read and export the audit log | change anything |

## 13. Subscribers and data

§13.1 About 200,000 paying subscribers plus Free listeners, spread over the
four markets, with their listening history, all generated. The exact counts
come from the generator, which is deterministic for a given seed, and are
declared where they are shown.

§13.2 The generator has two sizes: a small one for tests and continuous
integration, and the full one for measurements. Figures quoted anywhere
state which size they come from.

§13.3 Everything simulated says so: on screen, in the README and in this
book.

## 14. The six scenarios

Each one has its own business reason and proves a different rule.

§14.1 **Student Autumn Pass (acquisition).** Three months at a reduced price
for verified students in Italy, new subscribers only, not combinable.
Marketing creates it, finance approves it (the price is below the floor),
it activates at 09:00 Italian time and appears on the site to those who are
eligible. A demo student subscribes at the right price and sees from when
they will pay the full price. It is the complete flow, and the first one
built.

§14.2 **Album release (acquisition from fans).** For Free listeners who
played a given artist for more than a set number of hours in the last 30
days. Eligibility comes from the listening data; it is where PostgreSQL
works on a large table, and its queries are measured before and after
indexes, monthly partitions and aggregates.

§14.3 **Family price increase in Germany (revenue management).** New
subscribers pay the new price from a date; existing subscribers receive a
consent request on the site (§8.2). The simulation shows who pays what and
from when, the revenue at risk under a declared acceptance rate, and who
would move to the Free plan.

§14.4 **Prepaid gift pass (a different product).** Three months paid in
advance, a single-use code, no renewal, unaffected by later price
increases. Finance sees the value sold and not yet earned (§9).

§14.5 **Student verification (the way in).** A simulated provider verifies;
verification expires after 12 months; incompatible discounts do not stack
(§10).

§14.6 **Safe launch (reliability).** A fault is caused during an
activation. Plancia never leaves half a configuration live, recovers on
its own and shows what happened, step by step. In the full system the
faults are real (the engine stopped, the database connection cut at every
step); in the browser demo the fault is simulated and says so. The checks
inject both faults in each of the five steps of an offer's launch, and in
the publish step of a list price's, and count the partial activations they
leave behind: there must be none.

§14.7 **A second company, in tests only.** A fictional software company
with seat-based plans goes through the same flows. It shows that Plancia
is not wired to music and could serve other subscription businesses. Taking
real payments would stay with a payment provider; Plancia governs
decisions, approvals and publication.

## 15. What Rione does not do

Real payments (the provider is simulated behind an interface, and a real one
would plug in there); real authentication (people enter with a role, but
permissions are real and enforced by the server); music playback and audio;
catalog licensing; taxes beyond each market's VAT rate; accounting and
revenue recognition beyond prepaid value not yet earned; translations of the
interface (prices are still written the way each country writes them); more
than one company in production; machine learning; real-time collaboration.

## 16. Assumptions in one place

| Assumption | Default | Where it is used |
|---|---|---|
| Artists' pool share `s` | 60% of net revenue | §5.2 |
| Guaranteed minimum `G` | €3.00; £2.60 | §5.3 |
| Payment cost `f` | 1.8% of gross receipts | §5.6 |
| Finance threshold | €20,000 of discount and top-up cost over the horizon | §7.3 |
| Notice before a price increase (IT, FR, UK) | 30 days | §8.6 |
| Consent window in Germany | 45 days | §8.2 |
| Student verification validity | 12 months | §10.2 |
| Declared exchange rate | 1 EUR = 0.83728 GBP (ECB, 23 October 2026) | §3.6 |
| Simulation horizon | 12 months | §6.6 |

## 17. Sources

Checked on 24 October 2026. Rulings are cited by court and date only.

- VAT Directive 2006/112/EC (consolidated 14 April 2025), art. 58, 59c, 98
  and Annexes II and III:
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02006L0112-20250414
- Consumer Rights Directive 2011/83/EU:
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32011L0083
- Unfair Terms Directive 93/13/EEC:
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:31993L0013
- Italy, VAT (DPR 633/1972, art. 16):
  https://www.normattiva.it/uri-res/N2Ls?urn:nir:presidente.repubblica:decreto:1972-10-26;633~art16!vig=2026-10-24
- Italy, Consumer Code, art. 33:
  https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2005-09-06;206~art33!vig=2026-10-24
- France, standard VAT rate: https://bofip.impots.gouv.fr/bofip/1376-PGP.html
- France, Consumer Code, art. R. 212-1 and R. 212-4:
  https://www.clauses-abusives.fr/textes-de-reference/
- Germany, VAT (UStG § 12): https://www.gesetze-im-internet.de/ustg_1980/__12.html
- Germany, Civil Code § 307: https://www.gesetze-im-internet.de/bgb/__307.html
- Kammergericht, press release 27/2023 of 15 November 2023:
  https://www.berlin.de/gerichte/presse/pressemitteilungen-der-ordentlichen-gerichtsbarkeit/2023/pressemitteilung.1385804.php
- Bundesgerichtshof, press release 184/2026 of 1 October 2026:
  https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2026/2026184.html
- United Kingdom, VAT rates: https://www.gov.uk/vat-rates and
  https://www.gov.uk/guidance/rates-of-vat-on-different-goods-and-services
- United Kingdom, VAT Act 1994, Schedule 4A, para. 15:
  https://www.legislation.gov.uk/ukpga/1994/23/schedule/4A/paragraph/15
- United Kingdom, Consumer Rights Act 2015, Schedule 2:
  https://www.legislation.gov.uk/ukpga/2015/15/schedule/2
- CMA37, unfair contract terms guidance:
  https://www.gov.uk/government/publications/unfair-contract-terms-cma37
- ECB euro foreign exchange reference rates:
  https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-gbp.en.html
