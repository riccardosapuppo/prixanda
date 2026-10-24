-- The second half of the change in two times that V12 began: the history
-- becomes the only place of a subscription's price, and the old column goes.
--
-- V12 expanded: it added the history, copied every price into it, and kept
-- the column, with a trigger copying into the history the price of every
-- subscription written with one, so that the engine of the version before,
-- which writes and reads the column, kept working beside the new one. The
-- engine of this version writes the first row of the history itself and
-- reads only the history; this migration contracts. It runs once no engine
-- of an earlier version writes or reads subscriptions: stop the engine,
-- migrate, start the new one (docs/runbook.md).

drop trigger subscription_price_from_row on subscription;
drop function subscription_price_from_row();

-- The column, and its check that a paid plan costs something, which the
-- history's own rule keeps (subscription_price_rules, RL010).
alter table subscription drop column price_minor;

-- Without the copying trigger, a writer could forget the first row: every
-- subscription has its price from its first day, checked when its
-- transaction commits, so that the row and its price are written together.
create function subscription_has_its_first_price() returns trigger
language plpgsql as $$
begin
  if not exists (select from subscription_price where subscription_id = new.id and from_on = new.started_on) then
    raise exception 'subscription % has no price from its first day, %', new.id, new.started_on using errcode = 'RL010';
  end if;
  return null;
end $$;

create constraint trigger subscription_has_its_first_price
  after insert on subscription
  deferrable initially deferred
  for each row execute function subscription_has_its_first_price();
