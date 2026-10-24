-- Markets, VAT rates, plans and what they include, and the people of the demo
-- with their roles (business book §2, §3 and §12).
--
-- Everything sold is sold in a market and in that market's local time: a
-- period is a range of local wall-clock times (timestamp without time zone),
-- read in the market's time zone. An instant is compared with it by converting
-- the instant into that time zone, which is never ambiguous. Local times that a
-- clock change skips or repeats are refused by the engine before they get here.

create extension if not exists btree_gist;

-- The engine's permissions belong to this role. The login it connects with is
-- a member of it, created by each environment, never by a migration.
do $$
begin
  if not exists (select from pg_roles where rolname = 'commerce_app') then
    create role commerce_app nologin;
  end if;
end $$;

create table market (
  code        char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name        text not null check (length(name) between 1 and 60),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  minor_units smallint not null check (minor_units between 0 and 3),
  time_zone   text not null,
  -- AT TIME ZONE refuses a zone it does not know.
  constraint market_time_zone_known check ((timestamptz '2000-01-01 00:00Z' at time zone time_zone) is not null),
  unique (code, currency)
);

insert into market (code, name, currency, minor_units, time_zone) values
  ('IT', 'Italy', 'EUR', 2, 'Europe/Rome'),
  ('FR', 'France', 'EUR', 2, 'Europe/Paris'),
  ('DE', 'Germany', 'EUR', 2, 'Europe/Berlin'),
  ('GB', 'United Kingdom', 'GBP', 2, 'Europe/London');

-- Standard VAT rates, each with the day it took effect (§3.3), checked on
-- official sources on 24 October 2026. A rate is dated data, never a constant.
create table vat_rate (
  market  char(2) not null references market (code),
  rate_bp integer not null check (rate_bp between 0 and 10000),
  valid   daterange not null check (not isempty(valid) and not lower_inf(valid)),
  source  text not null check (length(source) between 1 and 200),
  constraint vat_rate_no_overlap exclude using gist (market with =, valid with &&)
);

insert into vat_rate (market, rate_bp, valid, source) values
  ('IT', 2200, daterange('2013-10-01', null), 'DPR 633/1972, art. 16'),
  ('FR', 2000, daterange('2014-01-01', null), 'Code général des impôts, art. 278'),
  ('DE', 1900, daterange('2021-01-01', null), 'UStG § 12(1)'),
  ('GB', 2000, daterange('2011-01-04', null), 'VAT Act 1994, s. 2');

create table plan (
  id                  text primary key check (id ~ '^[a-z][a-z0-9-]{0,30}$'),
  name                text not null check (length(name) between 1 and 40),
  paid                boolean not null,
  seats               smallint not null check (seats between 1 and 10),
  needs_student_check boolean not null default false,
  constraint plan_student_check_only_when_paid check (paid or not needs_student_check),
  -- Lets other tables require a paid plan with a foreign key (prices) or
  -- tie a price of zero to the free plan (subscriptions).
  unique (id, paid)
);

insert into plan (id, name, paid, seats, needs_student_check) values
  ('free', 'Free', false, 1, false),
  ('individual', 'Individual', true, 1, false),
  ('duo', 'Duo', true, 2, false),
  ('family', 'Family', true, 5, false),
  ('student', 'Student', true, 1, true);

-- What a plan includes, per market and period, versioned like everything
-- else (§2.2): a change of entitlements is a change that goes through approval.
create table plan_entitlement (
  id             bigint generated always as identity primary key,
  plan_id        text not null references plan (id),
  market         char(2) not null references market (code),
  skips_per_hour smallint check (skips_per_hour > 0),
  audio          text not null check (audio in ('standard', 'lossless')),
  offline        boolean not null,
  valid          tsrange not null
                 check (not isempty(valid) and not lower_inf(valid) and lower_inc(valid) and not upper_inc(valid)),
  change_id      bigint,
  constraint plan_entitlement_no_overlap exclude using gist (plan_id with =, market with =, valid with &&)
);

comment on column plan_entitlement.skips_per_hour is 'null means unlimited';

-- A row in force is never edited (§4.2): the only change allowed is closing an
-- open period, once. Shared by every table of dated, versioned rows.
create function only_close_period() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'rows of % are never deleted: close their period instead', tg_table_name
      using errcode = 'RL001';
  end if;
  if (to_jsonb(new) - 'valid') <> (to_jsonb(old) - 'valid')
     or lower(new.valid) <> lower(old.valid)
     or not upper_inf(old.valid)
     or upper_inf(new.valid) then
    raise exception 'a row of % in force is never edited: only an open period can be closed, once', tg_table_name
      using errcode = 'RL001';
  end if;
  return new;
end $$;

create trigger plan_entitlement_only_close
  before update or delete on plan_entitlement
  for each row execute function only_close_period();

-- The people of the demo are named by role, never by a person's name (§12.1).
create table person (
  id    text primary key check (id ~ '^[a-z][a-z0-9-]{0,40}$'),
  label text not null check (length(label) between 1 and 60)
);

create table person_role (
  person_id text not null references person (id),
  role      text not null
            check (role in ('marketing', 'commercial_lead', 'finance', 'catalog_manager', 'on_call', 'auditor')),
  primary key (person_id, role)
);

grant select on market, vat_rate, plan, person, person_role to commerce_app;
grant select, insert on plan_entitlement to commerce_app;
grant update (valid) on plan_entitlement to commerce_app;
