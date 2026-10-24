-- The outcome of every call that changes something, kept under the
-- idempotency key the gateway sent with it.
--
-- A key belongs to whoever sent it (scope: the person acting, or "(public)"
-- for the site's calls without a person) and is bound to the method and to a
-- fingerprint of the request. The engine claims the key at the start of the
-- call's transaction and records the outcome before it commits, so:
--   * the same key with the same request returns the recorded outcome, a
--     refusal included, without doing the work again;
--   * the same key with another request is refused;
--   * a second call with the same key while the first runs waits for it,
--     because the claim is a row the first transaction has not committed;
--   * a call that failed records nothing (its transaction rolled back), so it
--     can be retried with the same key.

create table idempotent_call (
  scope        text not null check (scope ~ '^([a-z][a-z0-9-]{0,40}|\(public\))$'),
  key          text not null check (key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$'),
  method       text not null check (method ~ '^[a-z][a-z0-9.]*\.[A-Z][A-Za-z]*/[A-Z][A-Za-z]*$'),
  request_hash bytea not null check (length(request_hash) = 32),
  started_at   timestamptz not null,
  request_id   text not null check (length(request_id) between 1 and 100),
  response     bytea check (response is null or length(response) <= 4194304),
  outcome      text check (outcome in ('answer', 'refusal')),
  completed_at timestamptz,
  primary key (scope, key),
  constraint idempotent_call_completed_at_once check (
    (response is null) = (outcome is null) and (outcome is null) = (completed_at is null))
);

comment on column idempotent_call.request_hash is 'sha256 of the method, the role and the request as protobuf writes it deterministically';
comment on column idempotent_call.response is 'the response message as sent, protobuf bytes';

-- A claim is completed once, and nothing else about it ever changes.
create function idempotent_call_complete_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'an idempotent call is never deleted' using errcode = 'RL006';
  end if;
  if old.response is not null
     or (to_jsonb(new) - 'response' - 'outcome' - 'completed_at') <> (to_jsonb(old) - 'response' - 'outcome' - 'completed_at') then
    raise exception 'an idempotent call records its outcome once, and keeps its key, request and start'
      using errcode = 'RL006';
  end if;
  return new;
end $$;

create trigger idempotent_call_complete_once
  before update or delete on idempotent_call
  for each row execute function idempotent_call_complete_once();

grant select, insert on idempotent_call to commerce_app;
grant update (response, outcome, completed_at) on idempotent_call to commerce_app;
