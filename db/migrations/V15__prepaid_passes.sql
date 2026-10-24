-- Prepaid passes (business book §9, §14.4): months of a plan paid in
-- advance, sold as a single-use code that can be given as a gift. The pass
-- itself is a change of kind 'prepaid' (V2), approved and launched like any
-- other; this migration adds what its sale writes: the codes, their payments
-- and receipts, and the subscription a code is activated into, which is
-- never charged and never renewed.

create table prepaid_code (
  -- The code is a bearer secret, shown to its buyer only: the audit log, the
  -- outbox and the engine's log name a code by its id.
  id              bigint generated always as identity unique,
  code            text primary key check (code ~ '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$'),
  -- The pass, in the version that was on sale when the code was sold.
  change_id       bigint not null,
  version         integer not null,
  market          char(2) not null,
  currency        char(3) not null,
  plan_id         text not null,
  paid            boolean not null default true check (paid),
  months          integer not null check (months between 1 and 24),
  -- What it cost, VAT included, and its amount without VAT, which is earned
  -- in equal monthly parts from its activation (§9.2).
  price_minor     bigint not null check (price_minor > 0),
  net_minor       bigint not null check (net_minor > 0 and net_minor <= price_minor),
  buyer_id        bigint not null references subscriber (id),
  sold_at         timestamptz not null,
  -- The last day it can be activated, in the market's calendar.
  valid_until     date not null,
  state           text not null default 'pending'
                  check (state in ('pending', 'ready', 'activated', 'expired', 'failed')),
  activated_by    bigint references subscriber (id),
  activated_on    date,
  subscription_id bigint unique references subscription (id),
  expired_at      timestamptz,
  request_id      text not null check (length(request_id) between 1 and 100),
  constraint prepaid_code_pass_version foreign key (change_id, version) references change_version (change_id, version),
  constraint prepaid_code_market_currency foreign key (market, currency) references market (code, currency),
  constraint prepaid_code_paid_plan foreign key (plan_id, paid) references plan (id, paid),
  constraint prepaid_code_valid_after_its_sale check (valid_until >= (sold_at at time zone 'UTC')::date - 1),
  constraint prepaid_code_activated_whole check (
    (state = 'activated') = (activated_by is not null and activated_on is not null and subscription_id is not null)),
  constraint prepaid_code_expired_when check ((state = 'expired') = (expired_at is not null))
);

create index prepaid_code_by_buyer on prepaid_code (buyer_id, sold_at desc);
create index prepaid_code_ready on prepaid_code (valid_until) where state = 'ready';

-- RL012: a code keeps what was sold, moves forward once, and stays.
create function prepaid_code_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a prepaid code is never deleted' using errcode = 'RL012';
  end if;
  if (new.id, new.code, new.change_id, new.version, new.market, new.currency, new.plan_id, new.months, new.price_minor,
      new.net_minor, new.buyer_id, new.sold_at, new.valid_until, new.request_id)
     is distinct from
     (old.id, old.code, old.change_id, old.version, old.market, old.currency, old.plan_id, old.months, old.price_minor,
      old.net_minor, old.buyer_id, old.sold_at, old.valid_until, old.request_id) then
    raise exception 'prepaid code % keeps what was sold', old.id using errcode = 'RL012';
  end if;
  if new.state <> old.state and not (
       (old.state = 'pending' and new.state in ('ready', 'failed'))
       or (old.state = 'ready' and new.state in ('activated', 'expired'))) then
    raise exception 'prepaid code % cannot go from % to %', old.id, old.state, new.state using errcode = 'RL012';
  end if;
  if old.state = new.state and (new.activated_by, new.activated_on, new.subscription_id, new.expired_at)
     is distinct from (old.activated_by, old.activated_on, old.subscription_id, old.expired_at) then
    raise exception 'prepaid code % was settled, once', old.id using errcode = 'RL012';
  end if;
  return new;
end $$;

create trigger prepaid_code_guard
  before update or delete on prepaid_code
  for each row execute function prepaid_code_guard();
create trigger prepaid_code_no_truncate before truncate on prepaid_code
  for each statement execute function written_once();

-- A payment and its receipt are for a subscription confirmed from a quote,
-- or for a prepaid code: one or the other.
alter table payment alter column quote_id drop not null;
alter table payment alter column subscription_id drop not null;
alter table payment add column prepaid_code text unique references prepaid_code (code);
alter table payment add constraint payment_for_one_thing check (
  (quote_id is not null and subscription_id is not null and prepaid_code is null)
  or (quote_id is null and subscription_id is null and prepaid_code is not null));

create or replace function payment_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a payment is never deleted' using errcode = 'RL009';
  end if;
  if (new.quote_id, new.subscription_id, new.prepaid_code, new.subscriber_id, new.amount_minor, new.currency, new.provider,
      new.requested_at, new.request_id) is distinct from
     (old.quote_id, old.subscription_id, old.prepaid_code, old.subscriber_id, old.amount_minor, old.currency, old.provider,
      old.requested_at, old.request_id) then
    raise exception 'a payment keeps what was asked for' using errcode = 'RL009';
  end if;
  if old.state <> 'pending' then
    raise exception 'payment % is settled (%), and settles once', old.id, old.state using errcode = 'RL009';
  end if;
  return new;
end $$;

alter table receipt alter column subscription_id drop not null;
alter table receipt alter column quote_id drop not null;
alter table receipt add column prepaid_code text unique references prepaid_code (code);
alter table receipt add constraint receipt_for_one_thing check (
  (quote_id is not null and subscription_id is not null and prepaid_code is null)
  or (quote_id is null and subscription_id is null and prepaid_code is not null));

-- The subscription a code is activated into: the pass's plan, paid in
-- advance, so nothing is charged each month and its price in the history is
-- zero; for every other paid subscription a month costs something.
alter table subscription add column prepaid_code text unique references prepaid_code (code);

create or replace function subscription_price_rules() returns trigger
language plpgsql as $$
declare
  owner record;
begin
  select started_on, ended_on, paid, prepaid_code into owner from subscription where id = new.subscription_id;
  if new.from_on < owner.started_on or (owner.ended_on is not null and new.from_on >= owner.ended_on) then
    raise exception 'a price of subscription % is charged while it runs, from % (it runs from % to %)',
      new.subscription_id, new.from_on, owner.started_on, owner.ended_on using errcode = 'RL010';
  end if;
  if owner.prepaid_code is not null then
    if new.price_minor <> 0 then
      raise exception 'subscription % is a prepaid pass, never charged by the month', new.subscription_id
        using errcode = 'RL010';
    end if;
  elsif (owner.paid and new.price_minor <= 0) or (not owner.paid and new.price_minor <> 0) then
    raise exception 'subscription % costs more than zero on a paid plan, and nothing on the free plan', new.subscription_id
      using errcode = 'RL010';
  end if;
  if new.change_id is null and new.from_on <> owner.started_on then
    raise exception 'a later price of subscription % names the price migration that set it', new.subscription_id
      using errcode = 'RL010';
  end if;
  return new;
end $$;

-- A pass launches like any other change.
alter table launch drop constraint launch_kind_check;
alter table launch add constraint launch_kind_check check (kind in ('offer', 'list_price', 'price_migration', 'prepaid'));

grant select, insert on prepaid_code to commerce_app;
grant update (state, activated_by, activated_on, subscription_id, expired_at) on prepaid_code to commerce_app;
