# Runbook

For the on-call engineer (business book §12): what to do when a launch is
stuck, when the engine cannot be reached, and when the audit log's chain does
not verify. Each entry gives the symptoms, how to check, what to do, and how
to tell that it is resolved.

## What there is to look at

- **The engine's log**: one JSON line per event on its standard error, with
  the request id when there is one. The jobs (launches, the end of offers,
  the outbox, the pruning of idempotency keys) write one line per change of
  state, never one per pass: a launch that waits, or that was refused, says
  nothing more until something happens to it. The events that matter here:
  `launch_started`, `launch_step_done`, `launch_step_failed` and
  `launch_step_interrupted` (warning), `launch_refused` and `launch_failed`
  (warning), `launch_done`, `launch_cancelled`, `incident_opened` (warning),
  `incident_closed`, `jobs_pass_failed` (warning, once per cause) and
  `jobs_working_again`, `outbox_delivery_failed` (warning), and, from the
  server, `listening`, `stopping`, `stopped`, `cannot_listen`,
  `configuration` and `database_unreachable`. Every line of a launch carries
  its run, `launch-<id>`, which is also the request id of the audit events it
  wrote.
- **Health**: the standard gRPC health protocol on the engine's address
  (`127.0.0.1:4611` unless `COMMERCE_ENGINE_HOST` and `COMMERCE_ENGINE_PORT`
  say otherwise). SERVING while the database answers, NOT_SERVING when it
  does not.
- **Incidents**: the console's home lists today's incidents (GetOverview):
  every launch that failed or was refused, and every scheduled change that is
  not live five minutes after its start, the alarm. An incident closes by
  itself when its launch goes through.
- **LaunchService** (launches.proto): ListLaunches and GetLaunch for every
  role; RetryLaunch and CancelLaunch for the on-call engineer. The console
  reaches it through the gateway; without the console, any gRPC client with
  the internal token and the metadata of common.proto (`x-actor`,
  `x-actor-role: on_call`, `x-request-id`, and an `idempotency-key` on
  RetryLaunch and CancelLaunch).
- **The database**, read only: the tables `launch`, `launch_step`,
  `incident`, `outbox_message`, `site_notice` and `audit_event`. The queries
  below are written for `psql` on the engine's database (`npm run db -- url`
  prints the development URL).

Not here: a pager. The alarm is an incident in the platform and a warning
line in the log; forwarding warnings to a person's phone is the job of the
deployment's log collector, and this repository has none.

Not here either: OpenTelemetry traces. A call is already followed from the
site through the gateway and the engine to the audit log by its request id,
and a launch keeps every step, with its times, attempts and errors, in
PostgreSQL, which is what the fault tests read. Traces would add a
dependency and a collector on the machine for nothing the tests need, so
they wait for a deployment that has a local collector.

## 1. A launch is stuck

**Symptoms**

- An open incident of kind `late`, `failed` or `refused` on the console's
  home, or in GetLaunch.
- A scheduled change's start has passed, and the site does not show it.
- In the log: `incident_opened`, `launch_refused` or `launch_failed`, with
  the run `launch-<id>`.

**Check**

1. Read the launch, step by step: GetLaunch, or

   ```sql
   select l.id, l.state, l.retry_at, l.cause, s.name, s.state, s.attempts, s.error
   from launch l join launch_step s on s.launch_id = l.id
   where l.change_id = <change id> order by s.position;
   ```

2. Read where it stopped:
   - **refused** at its check or publish step: an offer of the same
     non-combinability group is live for the same people (the cause names
     it, §6.4), or the price list holds a later price for the same plan and
     market (§4.1). Nothing was published, and the change is still
     scheduled.
   - **failed** at check, prepare or publish: the error of the fifth attempt
     in a row (the database did not answer, a statement timed out). Nothing
     was published.
   - **failed** at notify or verify: the change **is live**, since its
     publish step is done. The site's inbox did not take the notice, or the
     live catalog did not show the change as published.
   - **running**, with a `retry_at`: it waits for its next attempt, after 5,
     15, 45 or 135 seconds. Nothing to do unless the cause will not go away
     by itself.
   - **running**, with no `retry_at` and no new log lines: the engine is
     not running its jobs. Go to "The engine cannot be reached", and check
     that `COMMERCE_ACTIVATION_INTERVAL_SECONDS` is not 0.
3. Check that the live catalog is whole: the change is either absent from
   it (scheduled) or present in every market of its offer (active), never in
   some of them.

   ```sql
   select change_id, market from catalog_offer
   where snapshot_id = (select snapshot_id from catalog_publication order by seq desc limit 1)
   order by change_id, market;
   ```

**Act**

- **Refused by a clash**: decide which offer goes live. Suspend the live one
  (SuspendChange, with a reason), then RetryLaunch; or give this launch up
  with CancelLaunch, with a reason: its change is cancelled with it.
- **Refused by a later price**: the price list already holds a price from
  the same moment or later. The commercial lead and finance decide; the
  launch is usually cancelled (CancelLaunch), and a new list price change
  follows the usual approvals.
- **Failed before publishing**: remove the cause (the database is back, the
  disk has room), then RetryLaunch. It starts again at the step that failed;
  the steps done are not done again.
- **Failed after publishing**: the change is live. RetryLaunch delivers the
  site's notice and verifies the catalog; CancelLaunch is refused, because
  the change is live. To take the offer off the site, SuspendChange.
- **Late, without a failure**: the engine was not running at the start.
  Once it runs again, the launch goes through by itself and the incident
  closes as recovered.

**Resolved when** GetLaunch shows the launch done, with its five steps done,
and its incident closed (recovered, or resolved by the person who retried
or cancelled it); the live catalog shows the offer in all its markets, or
the price list holds the new price; and the log has `launch_done` and
`incident_closed` for the run.

## 2. The engine cannot be reached

**Symptoms**

- The gateway answers with errors or time-outs on every call that reaches
  the engine; the console cannot load its data.
- Health is NOT_SERVING, or does not answer at all.
- In the log: `database_unreachable`, `jobs_pass_failed`, or no lines at
  all.

**Check**

1. Is the process there, and listening? `netstat -a -n -o` on Windows,
   `ss -ltnp` on Linux, on the engine's port.
2. Ask health on the engine's address: SERVING, NOT_SERVING (the database
   does not answer), or no answer (the process is not listening).
3. Read the engine's last log lines: `listening` (it started), `stopping`
   and `stopped` (an orderly stop), `cannot_listen` (its port was taken),
   `configuration` (a setting is missing: it exits with code 2),
   `database_unreachable` (it runs, and the database does not answer).
4. Check the database: `npm run db -- info` in development, the database
   service's own health elsewhere.

**Act**

- **Not running**: start it (`npm run engine` in development, the
  supervisor elsewhere). At its start the engine runs its jobs at once: a
  launch it stopped in the middle of resumes at the step it stopped in.
- **Its port is taken** (`cannot_listen`): find who listens (step 1) and
  stop it, or give the engine another port.
- **A setting is missing** (`configuration`, exit code 2): set
  `COMMERCE_DATABASE_URL` and `COMMERCE_INTERNAL_TOKEN` (the gateway's
  token; in development `npm run engine` reads it from
  `.data/internal-token`).
- **The database does not answer**: bring the database back. The engine
  needs no restart: its pool opens connections when they are needed, health
  goes back to SERVING, and the jobs resume.

**Resolved when** health answers SERVING; the gateway's calls answer; the
log shows `listening` after a start, or `jobs_working_again` after the
database came back, and no new `jobs_pass_failed`; and every launch due
meanwhile is done, or has its incident to follow with entry 1.

## 3. The audit log's chain does not verify

**Symptoms**

- VerifyChain (the auditor or the on-call engineer) answers `ok: false`,
  with `broken_at` and `why`.
- VerifyChain with the head the auditor exported last (ExportHead) says
  that the chain no longer leads to it.
- The invariants command reports `audit_chain_verifies` broken.

**Check**

1. VerifyChain without a head: where the walk breaks, and why. A hash that
   does not match its event: an event was changed. A link that does not
   match the event before: an event was removed or the order changed
   (§11.3).
2. VerifyChain with the last exported head, which is kept outside the
   database: if the walk is whole but does not lead to that head, the chain
   was rewritten consistently after the export.
3. The same walk, from outside the engine, on one connection, with the
   project's Python (`.venv`) and `PYTHONPATH=services/commerce/src`:

   ```
   python -m commerce.invariants --url <URL> --anchor <seq>:<hash in hex>
   ```

4. Only a database administrator can do this: the trigger refuses every
   update, delete and truncate of the log, the owner's included, and the
   engine's role has no such right (§11.2). Read the database's own logs for
   a trigger switched off (`alter table audit_event disable trigger`) and for
   the administrators' sessions.

**Act**

- Treat it as a security incident. Do not repair the chain: computing the
  hashes again would hide what happened.
- Keep the evidence: a dump of the database as it is (`pg_dump`), the
  exported heads, and the engine's log; tell the auditor; restrict the
  administrators' access.
- Find the last good point: the latest exported head that the chain still
  leads to. The events after it are in doubt. Compare them with a backup of
  the database and with the engine's log, where each event's request id
  appears on the line of the call that wrote it.

**Resolved when** the auditor holds the evidence and knows the cause; the
database in use is one whose chain verifies against the last head exported
before the break (a backup, restored); and a new head has been exported
from it.
