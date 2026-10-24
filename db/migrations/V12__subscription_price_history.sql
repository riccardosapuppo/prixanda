-- A subscription's price becomes a history (business book §4.3, §8): the
-- first half of a change made in two times. This migration expands: it adds
-- the history beside the price each subscription row has had since V5, and
-- copies that price into it. A later migration contracts: it removes the old
-- column, once no running engine reads it.
--
-- Meanwhile both are kept: an engine of the version before this one still
-- writes subscriptions with their price and reads it from subscription; the
-- engine of this version reads the history. So that a subscription written by
-- the older engine has its history too, a trigger copies its price into the
-- history when the row is inserted. A price that changes later (a price
-- migration, §8) is a new row of the history, from its own day.

create table subscription_price (
  subscription_id bigint not null references subscription (id),
  -- The first day this price is charged at: the subscription's start, or the
  -- day a later price takes over.
  from_on         date not null,
  price_minor     bigint not null check (price_minor >= 0),
  -- The price migration that set it; none for the price the subscription started at.
  change_id       bigint references change (id),
  primary key (subscription_id, from_on)
);

insert into subscription_price (subscription_id, from_on, price_minor)
  select id, started_on, price_minor from subscription;

-- What a subscription costs on a day is the row of the history with the
-- latest from_on on or before that day.
create function subscription_price_rules() returns trigger
language plpgsql as $$
declare
  owner record;
begin
  select started_on, ended_on, paid into owner from subscription where id = new.subscription_id;
  if new.from_on < owner.started_on or (owner.ended_on is not null and new.from_on >= owner.ended_on) then
    raise exception 'a price of subscription % is charged while it runs, from % (it runs from % to %)',
      new.subscription_id, new.from_on, owner.started_on, owner.ended_on using errcode = 'RL010';
  end if;
  if (owner.paid and new.price_minor <= 0) or (not owner.paid and new.price_minor <> 0) then
    raise exception 'subscription % costs more than zero on a paid plan, and nothing on the free plan', new.subscription_id
      using errcode = 'RL010';
  end if;
  if new.change_id is null and new.from_on <> owner.started_on then
    raise exception 'a later price of subscription % names the price migration that set it', new.subscription_id
      using errcode = 'RL010';
  end if;
  return new;
end $$;

create trigger subscription_price_rules
  before insert on subscription_price
  for each row execute function subscription_price_rules();

create trigger subscription_price_written_once before update or delete on subscription_price
  for each row execute function written_once();
create trigger subscription_price_no_truncate before truncate on subscription_price
  for each statement execute function written_once();

-- While the old column lasts: a subscription written with its price, by an
-- engine of either version, gets the first row of its history.
create function subscription_price_from_row() returns trigger
language plpgsql as $$
begin
  insert into subscription_price (subscription_id, from_on, price_minor) values (new.id, new.started_on, new.price_minor);
  return new;
end $$;

create trigger subscription_price_from_row
  after insert on subscription
  for each row execute function subscription_price_from_row();

grant select, insert on subscription_price to commerce_app;
