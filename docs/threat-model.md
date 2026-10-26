# Threat model

Written on 25 October 2026 for the system as it is built: the console and
the site in the browser, the gateway with its two GraphQL APIs, the engine
behind gRPC, PostgreSQL, and the browser sandbox. Each threat names the
defence in the code and what is left.

## What is worth protecting

| Asset | Why it matters |
|---|---|
| The catalog in force | it is what a subscriber is shown and charged; a wrong price, an offer to the wrong audience or half a launch costs money |
| Approvals and separation of duties | who may sign what, and the rule that nobody signs their own work |
| The audit log | the record that the first two were respected |
| Subscribers' data | synthetic here, personal data in a real deployment |
| Prepaid codes | a code is a bearer secret, worth months of a plan to whoever holds it |
| Secrets | the engine's internal token, the key that signs sessions, and the database's passwords |

## Trust boundaries

1. Between the browser and the gateway, everything that arrives is
   untrusted.
2. Between the gateway and the engine, the engine accepts calls carrying the
   internal token, compared in constant time, and trusts the gateway's
   statement of who is acting (`x-actor`, `x-actor-role`). It then checks
   that the person holds that role, and every service checks the role against
   its own policy. On the site's calls there is no person: the engine also
   trusts the subscriber the gateway names in the request, which only the
   gateway can check, from its session.
3. Between the engine and the database, the engine connects with a role that
   can append to the audit log but not change it, and constraints and
   triggers hold the rules that must survive a bug in the engine.
4. In the sandbox, everything runs inside one visitor's browser, which that
   visitor controls entirely. Nothing in it is shared with anyone else or
   with a server, so its parts need no defence from one another; what is
   left is the integrity of the files the static host serves.

## Threats

| Threat | Defence | Left over |
|---|---|---|
| Someone acts as another person or takes a role they do not have | Demonstration sign-in only. The gateway refuses to serve the console's API in production mode and keeps no sessions on the site's API there (`services/gateway/src/node/config.ts`); the engine checks that the person holds the role | no real authentication exists; until an identity provider is added, the system must not hold real data |
| Session theft or fixation | random session ids in cookies signed with HMAC-SHA256, HttpOnly, SameSite=Strict, Secure when configured; a new id at every sign-in; idle and absolute expiry; a bounded number of sessions (`sessions.ts`) | locally the APIs run on plain HTTP on 127.0.0.1; a deployment needs TLS |
| Cross-site request forgery | SameSite=Strict, a CSRF token on every mutation, an origin allow-list per API, JSON bodies only, Apollo's CSRF prevention (`http.ts`) | none known |
| Calling an operation the role may not use | the gateway's role table per method (`core/roles.ts`); the engine's policy per operation (`domain/policy.py`) | the two tables must stay aligned; a test compares the gateway's with the business book |
| Self-approval, or approving something other than what was reviewed | engine refusal and database constraints: the author never signs, the signer holds the role, the version and its content fingerprint are the current ones, one signature per person per version, a new version clears earlier signatures | none known |
| Two people acting on the same change at once | transactions, version checks on every save, uniqueness in the database; concurrent approvals and saves are tested (`tests/services/test_review.py`, `test_change_versions.py`) | none known |
| Replayed or duplicated requests | an idempotency key on every call that changes something; the first answer is returned again, a key reused for another call is refused, keys are pruned after seven days; the apps send a key again only to retry after a transport failure, and take a new one after any answer, so a refusal is never replayed after its cause is gone; payment events count once in any order (`engine/idempotency.py`, `engine/payments.py`) | a retry after the pruning window is treated as new |
| A prepaid code guessed, leaked or used twice | 12 characters drawn with Python's `secrets` from an alphabet of 31 (about 59 bits); one activation, under a lock on the code's row; the audit log, the outbox and the engine's log name a code by its number, and an end-to-end test checks that no log line holds one | codes are kept in clear in the database; guessing is slowed only by the general rate limits |
| Tampering with the audit log | append-only grants for the engine's role, triggers against the owner, a SHA-256 chain verified on demand, an exported head to keep elsewhere | an administrator of the database can rewrite the whole chain consistently; only a comparison with an earlier exported head reveals it |
| A published state that is half old, half new | the catalog is published in one transaction; a launch resumes from its step; the outbox only delivers what was committed; faults are injected at every step and leave no partial activation | in the sandbox the fault is simulated |
| Injection | SQL with parameters only (asyncpg); typed GraphQL inputs and protobuf messages; validation in the engine before any write | none known |
| Internal details leaking | the public schema has no internal field, and no id but those the site acts on (offers, quotes, passes, price changes, the demo's listeners), checked by a test; refusals on the public API are the gateway's own sentences; unexpected errors reach the client as a code and a request id; introspection is off in production; logs carry no secrets, cookies or client addresses | none known |
| Abuse and denial of service | query depth and cost limited before execution; pages of 1 to 100 rows; bodies up to 64 KiB; no batched requests; token buckets per session and per address; deadlines on every engine call | one process serves both APIs, so a flood on one slows the other; no protection in front of it against a distributed flood |
| Secrets in the wrong place | secrets only from the environment in production, generated into `.data` (ignored by git) in development, never logged; the author's publishing check scans commits for secrets | no secrets manager or rotation |
| The internal token leaks | the engine listens on 127.0.0.1 unless configured otherwise | whoever holds the token and reaches the engine can act as anyone; a deployment needs mutual TLS and a closed network |
| Vulnerable dependencies | pinned versions and a licence check in `npm test`; nothing younger than two weeks except a security fix, and the advisories read at each upgrade, both by hand | on 26 October 2026 no advisory left in the npm packages or in the engine's Python environment; the sandbox's protobuf 6.31.1, from Pyodide, has one on JSON parsing, which the engine does not use; no automated advisory scan in the CI |
| The sandbox mistaken for the real system, or the reverse | the sandbox is a separate static build with its own database in the browser; it calls no server; it says on every page what it is; a simulated fault is labelled as simulated | none known |
