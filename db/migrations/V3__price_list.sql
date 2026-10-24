-- The price list (business book §4): one price per paid plan, market and
-- period of local time, including VAT, in the currency's minor unit.
--
-- The database refuses two prices for the same plan and market whose periods
-- overlap, a price for the free plan, a currency that is not the market's, and
-- any edit of a price in force other than closing its period (§4.2).

create table list_price (
  id           bigint generated always as identity primary key,
  plan_id      text not null,
  paid         boolean not null default true check (paid),
  market       char(2) not null,
  currency     char(3) not null,
  amount_minor bigint not null check (amount_minor > 0),
  valid        tsrange not null
               check (not isempty(valid) and not lower_inf(valid) and lower_inc(valid) and not upper_inc(valid)),
  change_id    bigint references change (id),
  constraint list_price_paid_plan foreign key (plan_id, paid) references plan (id, paid),
  constraint list_price_market_currency foreign key (market, currency) references market (code, currency),
  constraint list_price_no_overlap exclude using gist (plan_id with =, market with =, valid with &&)
);

comment on column list_price.valid is 'local wall-clock times in the market''s time zone, start included, end excluded';
comment on column list_price.change_id is 'the approved change that created the price; null for the price list loaded at the start of the data';

create trigger list_price_only_close
  before update or delete on list_price
  for each row execute function only_close_period();

grant select, insert on list_price to commerce_app;
grant update (valid) on list_price to commerce_app;
