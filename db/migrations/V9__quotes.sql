-- Quotes (business book §4.5): the price is always the engine's. The site
-- asks for a quote, shows it and later confirms it by its identifier, and the
-- engine charges what it quoted, until the quote expires.
--
-- A quote names the published catalog its offer came from, so that what the
-- site was shown can be traced back. It is written once.

create table quote (
  id               text primary key check (id ~ '^q_[0-9a-f]{32}$'),
  created_at       timestamptz not null,
  expires_at       timestamptz not null,
  market           char(2) not null,
  currency         char(3) not null,
  plan_id          text not null,
  paid             boolean not null default true check (paid),
  price_minor      bigint not null check (price_minor > 0),
  list_price_minor bigint not null check (list_price_minor > 0),
  months_at_price  integer not null check (months_at_price between 0 and 36),
  then_price_minor bigint not null check (then_price_minor > 0),
  offer_change_id  bigint,
  offer_version    integer,
  snapshot_id      bigint references catalog_snapshot (id),
  subscriber_id    bigint references subscriber (id),
  request_id       text not null check (length(request_id) between 1 and 100),
  constraint quote_expires_after_it_is_made check (expires_at > created_at),
  constraint quote_market_currency foreign key (market, currency) references market (code, currency),
  constraint quote_paid_plan foreign key (plan_id, paid) references plan (id, paid),
  constraint quote_offer_version foreign key (offer_change_id, offer_version) references change_version (change_id, version),
  -- At the list price, or at an offer's price below it, for its months.
  constraint quote_list_price_or_offer check (
    (offer_change_id is null and offer_version is null and snapshot_id is null
     and months_at_price = 0 and price_minor = list_price_minor)
    or (offer_change_id is not null and offer_version is not null and snapshot_id is not null
        and months_at_price > 0 and price_minor < list_price_minor))
);

create index quote_by_subscriber on quote (subscriber_id, created_at desc) where subscriber_id is not null;

create trigger quote_written_once before update or delete on quote
  for each row execute function written_once();
create trigger quote_no_truncate before truncate on quote
  for each statement execute function written_once();

grant select, insert on quote to commerce_app;
