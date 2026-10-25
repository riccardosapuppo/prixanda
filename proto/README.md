# The contract

`commerce/v1/*.proto` is where the commerce engine and the gateway meet: the
engine serves it over gRPC (`services/commerce`), and the gateway calls it
(`services/gateway`). `npm run proto` generates the code of both sides from
it: JavaScript with its type declarations in `packages/contracts/gen`, and the
engine's Python modules in `services/commerce/src/commerce/v1`. The generated
code is committed, and the check compares it with a fresh generation.

The contract changes by addition only: new fields, new messages, new methods.
`buf breaking`, in its FILE mode (`buf.yaml`), refuses anything else, and a
change of the contract is a commit of its own, regenerated.

What every call carries, and what it can answer, is written below once, for
the engine and the gateway alike: the conventions of the metadata, then the
engine's behaviours, which the gateway's fake engine
(`services/gateway/test/support/fake-engine.ts`) mirrors, then who may call
each method. The comments of `commerce/v1/common.proto` say the same of money,
local times and refusals, where the messages are.

## Conventions

1. `x-actor-role` carries the role's name as the business book and the
   database write it: `marketing`, `commercial_lead`, `finance`,
   `catalog_manager`, `on_call`, `auditor` (§12), never the enum's
   (`ROLE_FINANCE`).
2. Some methods act for nobody, and the gateway sends them neither `x-actor`
   nor `x-actor-role`: `ListPeople`, `ListMarkets`, `ListPlans`,
   `GetPriceList`, `ListOffers`, `ListPrepaidPasses`, `GetQuote` and
   `ListDemoListeners`. Others act for the listener of the site's session,
   with no person of the team either: `VerifyStudent`, `ConfirmQuote`,
   `GetAccount`, `AnswerPriceChange`, `BuyPrepaidPass` and
   `ActivatePrepaidPass`; their subscriber id is the session's, which the
   gateway writes itself. The engine accepts a call without an actor on
   these methods only, and refuses it with `PERMISSION_DENIED` on any other.
3. `GetQuote` saves the quote it answers, so it carries an `idempotency-key`
   like every method that changes something (behaviour 2).
4. The internal token, which the gateway sends as `authorization: Bearer
   <token>` and the engine checks on every call, is `COMMERCE_INTERNAL_TOKEN`.
   On a development machine without it, it is the file `.data/internal-token`
   (32 random bytes, in hexadecimal, ignored by git), created by whichever of
   the engine or the gateway starts first, exclusively, so that the second
   reads the first one's (`tools/lib/internal-token.ts`). The gateway reaches
   the engine at `ENGINE_URL`, `http://127.0.0.1:4611` by default.
5. `x-request-id` and `idempotency-key` have one shape,
   `^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$`, which stays under the 100
   characters of `audit_event.request_id`. The gateway makes a new request id
   (a UUID) when the client sent none, or a malformed one; it never makes up
   an idempotency key. The engine refuses a malformed value with
   `INVALID_ARGUMENT`.

## The engine's behaviours

1. gRPC's status codes mean, and only mean: `UNAUTHENTICATED`, no internal
   token, or the wrong one; `INVALID_ARGUMENT`, a malformed call (an
   `x-request-id` or `idempotency-key` missing where it is needed, or
   malformed, a field that cannot mean anything, a key reused for another
   request); `PERMISSION_DENIED`, no person on a method that acts for one, a
   person who does not exist or does not hold the role they claim, or a role
   that may not read what it asks for; `NOT_FOUND`, an id that names nothing;
   `FAILED_PRECONDITION`, data not in a state the call can be served from;
   `ABORTED`, a call with the same idempotency key still running;
   `UNAVAILABLE`, a database that cannot be reached; `INTERNAL`, an engine
   that broke, with no detail but the request id its log keeps them under.
   On the methods for nobody, an `x-actor` that is sent is checked all the
   same.
2. The methods that change something need an `idempotency-key`:
   ChangeService's `CreateChange`, `SaveVersion`, `ValidateChange`,
   `SubmitChange`, `ApproveChange`, `RejectChange`, `ScheduleChange`,
   `CancelChange` and `SuspendChange`; `GetQuote`; `ExportHead`, which writes
   `audit.exported`; the listener's `VerifyStudent`, `ConfirmQuote`,
   `AnswerPriceChange`, `BuyPrepaidPass` and `ActivatePrepaidPass`; the
   on-call engineer's `RetryLaunch` and `CancelLaunch`. Each person has keys
   of their own, and the site's calls share one space. The same key with the
   same request answers what it answered the first time, a refusal included;
   the same key with another request, method or role is `INVALID_ARGUMENT`,
   and while the first call runs, `ABORTED`. A gRPC error is not kept: the
   call can be made again. A key is kept for a week after its call.
3. `ValidateChange` that finds a blocking problem answers the refusal
   `REFUSAL_CODE_INVALID` (its facts: `blocking`, the number of problems, and
   `checks`, which ones) and keeps the report, which `GetChange` shows; a
   version without one moves the draft to validated.
4. When no condition of §7.3 asks for finance, the one signature a version
   needs names `ROLE_COMMERCIAL_LEAD`, and its reason says that the commercial
   lead or finance signs.
5. A simulation's `break_even_retention_bp` is -1 when no retention would
   break even.
6. A role that may not do something gets the refusal
   `REFUSAL_CODE_ROLE_NOT_ALLOWED` on a method whose response has an outcome,
   and `PERMISSION_DENIED` on a read that has none. A business refusal is an
   answer, never an error: the rules said no, and nothing broke.
7. `x-request-id` comes back in the response's metadata, at its start and in
   its trailers, errors included, when it was well formed.

## Who may call each method

The roles of the business book's §12, method by method. The engine decides,
as the trusted layer (§7.4); the gateway repeats the same matrix before it
calls the engine (`services/gateway/src/core/roles.ts`), so that a role never
reaches an operation it cannot do. Where the kind of change decides, an offer
is marketing's, and a list price, a price migration (§8, §14.3) and a prepaid
pass (§9, §14.4) are the commercial lead's.

| Method | Who |
|---|---|
| The methods of convention 2 | nobody of the team: a call for nobody, or for the site's listener |
| `CreateChange`, `SaveVersion`, `ValidateChange`, `SubmitChange` | the role that writes that kind of change: marketing for an offer, the commercial lead for a list price, a price migration or a prepaid pass |
| `SimulateOffer`, `SimulateMigration` | marketing, the commercial lead, finance |
| `ApproveChange`, `RejectChange` | finance, the commercial lead; the engine checks which signatures the version needs, and that its author does not sign |
| `ScheduleChange` | marketing or the commercial lead for an offer; the commercial lead for the other kinds. Finance approves and does not schedule: separation of duties |
| `CancelChange` | marketing, the commercial lead or the on-call engineer for an offer; the commercial lead or the on-call engineer for the other kinds (cancelling a scheduled launch is the rollback of §12) |
| `SuspendChange` | the on-call engineer |
| `GetChange`, `BatchGetChanges`, `ListChanges`, `GetOverview`, `ListEvents`, `ListLaunches`, `GetLaunch` | every role: the log is read, never changed (§11.4) |
| `VerifyChain` | the auditor, the on-call engineer (runbook: the chain does not verify) |
| `ExportHead` | the auditor |
| `RetryLaunch`, `CancelLaunch` | the on-call engineer |

`GetOverview` answers every role, with two figures reserved (§12.2): the
month's revenue (`monthly_revenue`, `monthly_revenue_eur`, `monthly_top_ups`)
for finance and the commercial lead, and the value of prepaid passes sold and
not yet earned for finance alone (§9.2). The engine leaves them out of its
answer to the other roles, and the gateway answers FORBIDDEN on those fields.

## Money, time and identifiers

- Money is an integer in the currency's minor unit, with its ISO 4217 code
  (`Money`: §3.4). JavaScript reads amounts and counts as `bigint`.
- Identifiers are opaque: JavaScript reads them as strings
  (`jstype = JS_STRING`).
- An instant is ISO 8601 in UTC, with `Z`. A time scheduled for a market is a
  `LocalTime`: the market, the wall-clock time there without an offset, and
  the instant it falls on, which the engine computes (§3.7), so that 09:00 in
  Italy stays 09:00 in Italy across a change of the clocks. A local time that
  the clocks skip or repeat is refused (`REFUSAL_CODE_AMBIGUOUS_LOCAL_TIME`).
- A refusal's `reason` is one sentence for people, in English; its `facts`
  carry the numbers and the names the sentence is made of.

The engine also serves the standard health protocol (`grpc/health/v1`):
SERVING while its database answers.
