-- Safe launches (business book §7.5, §14.6): the activation of a scheduled
-- change becomes a job of steps kept here, with the incidents it opens; an
-- outbox carries what the platform announces after a commit (the catalog's
-- notices for the site, the first month's charge for the payment provider);
-- the payment and the provider's events are kept, each event counted once;
-- and the idempotency keys of calls long finished can be pruned.
--
-- Two rules of earlier migrations change, both in a way that keeps their
-- guarantee:
--   * a snapshot may be prepared with an offer whose launch is under way
--     (scheduled), but it can only go live when every offer in it is active at
--     its current version: the guard moves from writing a snapshot to
--     publishing one, which is what the site reads;
--   * an idempotency key whose call has finished may be deleted (the pruning
--     job of the engine), while a key whose call is still running may not.

-- -- Launches ------------------------------------------------------------------

-- RL008: a launch, one of its steps or an incident moves in a way the job does
-- not (a step done done again, a launch that published cancelled, a closed
-- incident reopened).

create table launch (
  id              bigint generated always as identity primary key,
  change_id       bigint not null unique,
  version         integer not null,
  kind            text not null check (kind in ('offer', 'list_price')),
  state           text not null default 'running'
                  check (state in ('running', 'done', 'failed', 'refused', 'cancelled')),
  -- The change's first local start, and the instant it falls on.
  starts_market   char(2) not null references market (code),
  starts_local    timestamp not null,
  starts_at       timestamptz not null,
  due_at          timestamptz not null,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  retry_at        timestamptz,
  cause           text check (cause is null or length(cause) between 1 and 2000),
  resolution      text check (resolution is null or length(resolution) between 1 and 2000),
  -- The last person who retried it: when it then goes through, its incident
  -- was resolved by a person, not recovered on its own.
  retried_by      text check (retried_by is null or retried_by ~ '^[a-z][a-z0-9-]{0,40}$'),
  snapshot_before bigint references catalog_snapshot (id),
  snapshot_after  bigint references catalog_snapshot (id),
  constraint launch_version foreign key (change_id, version) references change_version (change_id, version),
  constraint launch_stopped_when_not_running check ((state = 'running') = (finished_at is null)),
  constraint launch_retries_while_running check (retry_at is null or state = 'running'),
  constraint launch_due_before_its_start check (due_at <= starts_at)
);

create index launch_runnable on launch (retry_at, id) where state = 'running';

create table launch_step (
  launch_id   bigint not null references launch (id),
  position    smallint not null,
  name        text not null,
  state       text not null default 'pending' check (state in ('pending', 'running', 'done', 'failed')),
  started_at  timestamptz,
  finished_at timestamptz,
  attempts    integer not null default 0 check (attempts >= 0),
  -- Failed attempts in a row, since the last success or the last retry by a person.
  failures    integer not null default 0 check (failures >= 0),
  error       text check (error is null or length(error) between 1 and 2000),
  facts       jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
  primary key (launch_id, position),
  unique (launch_id, name),
  constraint launch_step_order check (
    (name, position) in (('check', 1), ('prepare', 2), ('publish', 3), ('notify', 4), ('verify', 5))),
  constraint launch_step_started check ((state = 'pending') = (started_at is null)),
  constraint launch_step_finished check ((state in ('done', 'failed')) = (finished_at is not null)),
  constraint launch_step_pending_untouched check (state <> 'pending' or (attempts = 0 and error is null)),
  constraint launch_step_failed_says_why check (state <> 'failed' or error is not null),
  constraint launch_step_done_clean check (state <> 'done' or error is null)
);

-- The audit events a launch wrote, or that people wrote about it, by their
-- sequence numbers. Written in the transaction of the event; the log is
-- append-only and nothing references it, so that it stays one table no
-- statement can truncate (V4).
create table launch_event (
  launch_id bigint not null references launch (id),
  seq       bigint not null check (seq > 0),
  primary key (launch_id, seq)
);

create function launch_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a launch is never deleted' using errcode = 'RL008';
  end if;
  if (new.change_id, new.version, new.kind, new.starts_market, new.starts_local, new.starts_at, new.due_at, new.started_at)
     is distinct from
     (old.change_id, old.version, old.kind, old.starts_market, old.starts_local, old.starts_at, old.due_at, old.started_at) then
    raise exception 'a launch keeps its change, its version and its times' using errcode = 'RL008';
  end if;
  if new.state <> old.state and not (
       (old.state = 'running' and new.state in ('done', 'failed', 'refused', 'cancelled'))
       or (old.state in ('failed', 'refused') and new.state in ('running', 'cancelled'))) then
    raise exception 'a launch cannot go from % to %', old.state, new.state using errcode = 'RL008';
  end if;
  if old.snapshot_after is not null and new.snapshot_after is distinct from old.snapshot_after then
    raise exception 'launch % published snapshot % and publishes once', old.id, old.snapshot_after using errcode = 'RL008';
  end if;
  if new.state = 'done' and exists (select from launch_step s where s.launch_id = new.id and s.state <> 'done') then
    raise exception 'launch % is done only when all its steps are', new.id using errcode = 'RL008';
  end if;
  if new.state = 'cancelled' and old.state <> 'cancelled'
     and exists (select from launch_step s where s.launch_id = new.id and s.name = 'publish' and s.state = 'done') then
    raise exception 'launch % published: its change is live, and a suspension takes it off the site', new.id
      using errcode = 'RL008';
  end if;
  return new;
end $$;

create trigger launch_guard
  before update or delete on launch
  for each row execute function launch_guard();

create function launch_step_guard() returns trigger
language plpgsql as $$
declare
  owner_state text;
begin
  if tg_op = 'DELETE' then
    raise exception 'a launch step is never deleted' using errcode = 'RL008';
  end if;
  if (new.launch_id, new.position, new.name) is distinct from (old.launch_id, old.position, old.name) then
    raise exception 'a launch step keeps its launch, place and name' using errcode = 'RL008';
  end if;
  if old.state = 'done' then
    raise exception 'step % of launch % is done, and a step that is done is never done again', old.name, old.launch_id
      using errcode = 'RL008';
  end if;
  if new.state = 'pending' and old.state <> 'pending' then
    raise exception 'a launch step does not go back to pending' using errcode = 'RL008';
  end if;
  if new.attempts < old.attempts then
    raise exception 'the attempts of a launch step only grow' using errcode = 'RL008';
  end if;
  if new.name = 'publish' and new.state = 'done' then
    select c.state into owner_state from launch l join change c on c.id = l.change_id where l.id = new.launch_id;
    if owner_state is distinct from 'active' then
      raise exception 'the publish step of launch % is done only with its change active (it is %)', new.launch_id, owner_state
        using errcode = 'RL008';
    end if;
  end if;
  return new;
end $$;

create trigger launch_step_guard
  before update or delete on launch_step
  for each row execute function launch_step_guard();

create trigger launch_event_written_once before update or delete on launch_event
  for each row execute function written_once();

-- -- Incidents -----------------------------------------------------------------

-- A launch that failed or was refused, or a scheduled change not live five
-- minutes after its start. A launch has at most one open incident at a time.
-- An incident closes once: recovered when its launch went through and nobody
-- had to act; resolved when a person retried or cancelled the launch
-- (closed_by), or when its change was cancelled outside the launch.
create table incident (
  id         bigint generated always as identity primary key,
  launch_id  bigint not null references launch (id),
  kind       text not null check (kind in ('late', 'failed', 'refused')),
  summary    text not null check (length(summary) between 1 and 2000),
  opened_at  timestamptz not null,
  state      text not null default 'open' check (state in ('open', 'recovered', 'resolved')),
  closed_at  timestamptz,
  closed_by  text check (closed_by is null or closed_by ~ '^[a-z][a-z0-9-]{0,40}$'),
  resolution text check (resolution is null or length(resolution) between 1 and 2000),
  constraint incident_closed_with_a_resolution check (
    (state = 'open') = (closed_at is null) and (state = 'open') = (resolution is null)),
  constraint incident_only_a_person_resolves check (closed_by is null or state = 'resolved'),
  constraint incident_closed_after_it_opened check (closed_at is null or closed_at >= opened_at)
);

create unique index incident_one_open_per_launch on incident (launch_id) where state = 'open';
create index incident_by_opening on incident (opened_at desc, id desc);

create function incident_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an incident is never deleted' using errcode = 'RL008';
  end if;
  if old.state <> 'open' then
    raise exception 'incident % is closed, and stays as it closed', old.id using errcode = 'RL008';
  end if;
  if (new.launch_id, new.kind, new.summary, new.opened_at) is distinct from (old.launch_id, old.kind, old.summary, old.opened_at) then
    raise exception 'an incident keeps what it opened with' using errcode = 'RL008';
  end if;
  return new;
end $$;

create trigger incident_guard
  before update or delete on incident
  for each row execute function incident_guard();

-- -- The outbox, and the site's inbox ------------------------------------------

-- RL009: an outbox message, a notice of the site, a payment or an event of the
-- payment provider changes after the fact.

-- What the platform announces after a commit, written in the transaction of
-- the change it announces and delivered after it, at least once: a consumer
-- may receive a message twice, and takes it once.
create table outbox_message (
  id           bigint generated always as identity primary key,
  topic        text not null check (topic in ('catalog.published', 'payment.charge')),
  key          text not null check (length(key) between 1 and 100),
  payload      jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at   timestamptz not null,
  request_id   text not null check (length(request_id) between 1 and 100),
  attempts     integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null,
  delivered_at timestamptz,
  last_error   text check (last_error is null or length(last_error) between 1 and 2000),
  unique (topic, key)
);

create index outbox_message_due on outbox_message (available_at, id) where delivered_at is null;

create function outbox_message_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an outbox message is never deleted' using errcode = 'RL009';
  end if;
  if (new.topic, new.key, new.payload, new.created_at, new.request_id)
     is distinct from (old.topic, old.key, old.payload, old.created_at, old.request_id) then
    raise exception 'an outbox message keeps what it says' using errcode = 'RL009';
  end if;
  if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
    raise exception 'outbox message % was delivered, and is marked delivered once', old.id using errcode = 'RL009';
  end if;
  if new.attempts < old.attempts then
    raise exception 'the attempts of an outbox message only grow' using errcode = 'RL009';
  end if;
  return new;
end $$;

create trigger outbox_message_guard
  before update or delete on outbox_message
  for each row execute function outbox_message_guard();

-- The site's inbox: the catalog notices the outbox delivered to it, one row
-- per notice however often it arrived (arrivals counts the deliveries).
create table site_notice (
  message_id  bigint primary key references outbox_message (id),
  snapshot_id bigint not null references catalog_snapshot (id),
  publication bigint not null references catalog_publication (seq),
  received_at timestamptz not null,
  arrivals    integer not null default 1 check (arrivals >= 1)
);

-- -- The first month's payment, and the provider's events ----------------------

-- A subscription confirmed from a quote starts at once; its first month is
-- charged after the confirmation commits, through the outbox, and the
-- provider's events settle the payment (§4.5). The provider is simulated.
create table payment (
  id                 text primary key check (id ~ '^p_[0-9a-f]{32}$'),
  quote_id           text not null unique references quote (id),
  subscription_id    bigint not null unique references subscription (id),
  subscriber_id      bigint not null references subscriber (id),
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  provider           text not null check (provider = 'simulated'),
  state              text not null default 'pending' check (state in ('pending', 'succeeded', 'failed')),
  requested_at       timestamptz not null,
  request_id         text not null check (length(request_id) between 1 and 100),
  settled_at         timestamptz,
  provider_reference text check (provider_reference is null or length(provider_reference) between 1 and 100),
  failure_reason     text check (failure_reason is null or length(failure_reason) between 1 and 400),
  constraint payment_settled_when_not_pending check ((state = 'pending') = (settled_at is null)),
  constraint payment_declined_with_a_reason check ((state = 'failed') = (failure_reason is not null)),
  constraint payment_taken_with_a_reference check (state <> 'succeeded' or provider_reference is not null)
);

-- Each event the provider sent, by its own identifier: the second arrival of
-- an event only counts as an arrival. applied says whether it moved the
-- payment: an event that arrives after a later one (out of order) does not.
create table payment_event (
  provider    text not null check (provider = 'simulated'),
  event_id    text not null check (event_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  payment_id  text not null references payment (id),
  type        text not null check (type in ('charge.pending', 'charge.succeeded', 'charge.failed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  arrivals    integer not null default 1 check (arrivals >= 1),
  applied     boolean not null,
  primary key (provider, event_id)
);

create index payment_event_by_payment on payment_event (payment_id);

create function payment_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a payment is never deleted' using errcode = 'RL009';
  end if;
  if (new.quote_id, new.subscription_id, new.subscriber_id, new.amount_minor, new.currency, new.provider, new.requested_at,
      new.request_id) is distinct from
     (old.quote_id, old.subscription_id, old.subscriber_id, old.amount_minor, old.currency, old.provider, old.requested_at,
      old.request_id) then
    raise exception 'a payment keeps what was asked for' using errcode = 'RL009';
  end if;
  if old.state <> 'pending' then
    raise exception 'payment % is settled (%), and settles once', old.id, old.state using errcode = 'RL009';
  end if;
  return new;
end $$;

create trigger payment_guard
  before update or delete on payment
  for each row execute function payment_guard();

-- A notice of the site or an event of the provider: only its arrivals grow.
create function arrivals_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.arrivals < old.arrivals
     or (to_jsonb(new) - 'arrivals') <> (to_jsonb(old) - 'arrivals') then
    raise exception 'a row of % only counts its arrivals', tg_table_name using errcode = 'RL009';
  end if;
  return new;
end $$;

create trigger site_notice_arrivals_only before update or delete on site_notice
  for each row execute function arrivals_only();
create trigger payment_event_arrivals_only before update or delete on payment_event
  for each row execute function arrivals_only();

-- -- Snapshots prepared ahead, published only whole -----------------------------

create or replace function catalog_offer_write() returns trigger
language plpgsql as $$
declare
  owner_kind text;
  owner_state text;
  owner_version integer;
begin
  select kind, state, current_version into owner_kind, owner_state, owner_version from change where id = new.change_id;
  if owner_kind is distinct from 'offer' or owner_state not in ('active', 'scheduled') or owner_version is distinct from new.version then
    raise exception 'only the current version of an active offer, or of a scheduled one being launched, enters a snapshot (change %: %, %, version %)',
      new.change_id, owner_kind, owner_state, owner_version using errcode = 'RL007';
  end if;
  return new;
end $$;

create function catalog_publication_write() returns trigger
language plpgsql as $$
declare
  stray record;
begin
  select o.change_id, c.state, c.current_version, o.version as snapshot_version into stray
  from catalog_offer o join change c on c.id = o.change_id
  where o.snapshot_id = new.snapshot_id and (c.state <> 'active' or c.current_version <> o.version)
  limit 1;
  if found then
    raise exception 'a snapshot goes live only with active offers at their current version (change %: %, version % of %)',
      stray.change_id, stray.state, stray.snapshot_version, stray.current_version using errcode = 'RL007';
  end if;
  return new;
end $$;

create trigger catalog_publication_write
  before insert on catalog_publication
  for each row execute function catalog_publication_write();

-- -- Pruning the idempotency keys ----------------------------------------------

create or replace function idempotent_call_complete_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.response is null then
      raise exception 'a call still running keeps its idempotency key' using errcode = 'RL006';
    end if;
    return old;
  end if;
  if old.response is not null
     or (to_jsonb(new) - 'response' - 'outcome' - 'completed_at') <> (to_jsonb(old) - 'response' - 'outcome' - 'completed_at') then
    raise exception 'an idempotent call records its outcome once, and keeps its key, request and start'
      using errcode = 'RL006';
  end if;
  return new;
end $$;

create index idempotent_call_by_completion on idempotent_call (completed_at) where completed_at is not null;

-- -- What the engine's role may do -------------------------------------------

grant select, insert on launch, launch_step, launch_event, incident, outbox_message, site_notice, payment, payment_event
  to commerce_app;
grant update (state, finished_at, retry_at, cause, resolution, retried_by, snapshot_before, snapshot_after) on launch
  to commerce_app;
grant update (state, started_at, finished_at, attempts, failures, error, facts) on launch_step to commerce_app;
grant update (state, closed_at, closed_by, resolution) on incident to commerce_app;
grant update (attempts, available_at, delivered_at, last_error) on outbox_message to commerce_app;
grant update (arrivals) on site_notice, payment_event to commerce_app;
grant update (state, settled_at, provider_reference, failure_reason) on payment to commerce_app;
grant delete on idempotent_call to commerce_app;
