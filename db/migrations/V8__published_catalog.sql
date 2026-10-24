-- The catalog the site reads (business book §6.2, §7.5).
--
-- A snapshot holds the offers live at one moment, each with its price rule,
-- its period in the market's local time and the instants that period falls
-- on, its page and its audience. Snapshots are written once. A publication
-- moves the live pointer to a snapshot by adding a row: the live catalog is
-- the snapshot of the latest publication, and the history of the site is the
-- list of publications.
--
-- An activation writes the new snapshot and publishes it in the same
-- transaction that moves the change to active and writes its audit events, so
-- the site sees the old catalog or the new one, never part of either. Only the
-- current version of an active offer can enter a snapshot: a bug in the
-- engine cannot publish a draft.

create table catalog_snapshot (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null,
  created_by text not null check (created_by ~ '^[a-z][a-z0-9-]{0,40}$'),
  request_id text not null check (length(request_id) between 1 and 100),
  cause      jsonb not null check (jsonb_typeof(cause) = 'object')
);

create table catalog_offer (
  snapshot_id         bigint not null references catalog_snapshot (id),
  change_id           bigint not null,
  version             integer not null,
  market              char(2) not null,
  currency            char(3) not null,
  plan_id             text not null,
  paid                boolean not null default true check (paid),
  fixed_minor         bigint check (fixed_minor > 0),
  percent_off_bp      integer check (percent_off_bp between 1 and 9999),
  months              integer not null check (months between 1 and 36),
  starts_local        timestamp not null,
  ends_local          timestamp,
  starts_at           timestamptz not null,
  ends_at             timestamptz,
  title               text not null check (length(title) between 1 and 120),
  body                text not null check (length(body) between 1 and 2000),
  terms               text not null check (length(terms) between 1 and 4000),
  treatment           text not null check (length(treatment) <= 40),
  audience            jsonb not null check (jsonb_typeof(audience) = 'object'),
  audience_words      text not null check (length(audience_words) between 1 and 400),
  needs_student_check boolean not null,
  group_name          text not null check (group_name ~ '^[a-z][a-z0-9-]{0,39}$'),
  redemption_cap      integer not null check (redemption_cap >= 0),
  primary key (snapshot_id, change_id, market),
  constraint catalog_offer_version foreign key (change_id, version) references change_version (change_id, version),
  constraint catalog_offer_market_currency foreign key (market, currency) references market (code, currency),
  constraint catalog_offer_paid_plan foreign key (plan_id, paid) references plan (id, paid),
  constraint catalog_offer_one_price check (num_nonnulls(fixed_minor, percent_off_bp) = 1),
  constraint catalog_offer_period check (ends_local is null or ends_local > starts_local),
  constraint catalog_offer_period_instants check (
    (ends_local is null) = (ends_at is null) and (ends_at is null or ends_at > starts_at))
);

create function catalog_offer_write() returns trigger
language plpgsql as $$
declare
  owner_kind text;
  owner_state text;
  owner_version integer;
begin
  select kind, state, current_version into owner_kind, owner_state, owner_version from change where id = new.change_id;
  if owner_kind is distinct from 'offer' or owner_state is distinct from 'active' or owner_version is distinct from new.version then
    raise exception 'only the current version of an active offer is published (change %: %, %, version %)',
      new.change_id, owner_kind, owner_state, owner_version using errcode = 'RL007';
  end if;
  return new;
end $$;

create trigger catalog_offer_write
  before insert on catalog_offer
  for each row execute function catalog_offer_write();

create table catalog_publication (
  seq          bigint generated always as identity primary key,
  snapshot_id  bigint not null references catalog_snapshot (id),
  published_at timestamptz not null,
  published_by text not null check (published_by ~ '^[a-z][a-z0-9-]{0,40}$'),
  request_id   text not null check (length(request_id) between 1 and 100)
);

-- The live catalog, now or at an instant of the past.
create index catalog_publication_by_time on catalog_publication (published_at desc, seq desc);

create trigger catalog_snapshot_written_once before update or delete on catalog_snapshot
  for each row execute function written_once();
create trigger catalog_offer_written_once before update or delete on catalog_offer
  for each row execute function written_once();
create trigger catalog_publication_written_once before update or delete on catalog_publication
  for each row execute function written_once();
create trigger catalog_snapshot_no_truncate before truncate on catalog_snapshot
  for each statement execute function written_once();
create trigger catalog_offer_no_truncate before truncate on catalog_offer
  for each statement execute function written_once();
create trigger catalog_publication_no_truncate before truncate on catalog_publication
  for each statement execute function written_once();

grant select, insert on catalog_snapshot, catalog_offer, catalog_publication to commerce_app;
