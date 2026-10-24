-- The audit log (business book §11): one event for every change of state,
-- written in the same transaction as the change.
--
-- Append only: the engine's role may add and read events, and a trigger
-- refuses updates, deletes and truncation for everyone, the owner included.
--
-- Each event stores the hash of the one before it and its own, computed here
-- under a lock so that events form one chain in one order. What that really
-- guarantees (§11.3): an event changed, removed or reordered after the fact is
-- detected by recomputing the chain; it is not prevented, because an
-- administrator of the database can disable the trigger, rewrite events and
-- recompute every later hash. That is caught by comparing the chain with a
-- head exported earlier and kept outside the database. Tamper-evident against
-- that anchor, not immutable.

create table audit_event (
  seq        bigint primary key,
  at         timestamptz not null,
  actor      text not null check (actor ~ '^[a-z][a-z0-9-]{0,40}$'),
  actor_role text not null
             check (actor_role in ('marketing', 'commercial_lead', 'finance', 'catalog_manager',
                                   'on_call', 'auditor', 'system')),
  action     text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  subject    text not null check (length(subject) between 1 and 200),
  request_id text not null check (length(request_id) between 1 and 100),
  reason     text check (reason is null or length(reason) between 1 and 2000),
  body       jsonb not null check (jsonb_typeof(body) = 'object'),
  prev_hash  bytea not null check (length(prev_hash) = 32),
  hash       bytea not null check (length(hash) = 32)
);

comment on table audit_event is
  'hash = sha256(prev_hash || UTF-8 of jsonb_build_array(seq, at in UTC with microseconds, actor, actor_role, action, subject, request_id, reason, body)::text)';

create function audit_event_chain() returns trigger
language plpgsql as $$
declare
  previous_seq bigint;
  previous_hash bytea;
begin
  -- One writer at a time appends: the sequence and the link are taken under
  -- this lock, so concurrent transactions cannot fork the chain.
  perform pg_advisory_xact_lock(4600011);
  select seq, hash into previous_seq, previous_hash from audit_event order by seq desc limit 1;
  new.seq := coalesce(previous_seq, 0) + 1;
  new.prev_hash := coalesce(previous_hash, decode(repeat('00', 32), 'hex'));
  new.hash := sha256(new.prev_hash || convert_to(jsonb_build_array(
    new.seq,
    to_char(new.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    new.actor, new.actor_role, new.action, new.subject, new.request_id, new.reason, new.body
  )::text, 'UTF8'));
  return new;
end $$;

create trigger audit_event_chain
  before insert on audit_event
  for each row execute function audit_event_chain();

create function audit_event_refuse() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_event is append-only' using errcode = '42501';
end $$;

create trigger audit_event_no_change
  before update or delete on audit_event
  for each row execute function audit_event_refuse();

create trigger audit_event_no_truncate
  before truncate on audit_event
  for each statement execute function audit_event_refuse();

grant select, insert on audit_event to commerce_app;
revoke update, delete, truncate on audit_event from commerce_app;
