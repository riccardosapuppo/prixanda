-- Subscribers, what they pay, student verifications, and the listening data
-- that fan campaigns are aimed with (business book §4.3, §10, §13, §14.2).
-- All of it is generated: the people are invented and the counts come from
-- the generator, which is deterministic for a seed.

create table subscriber (
  id        bigint primary key,
  market    char(2) not null references market (code),
  joined_on date not null,
  unique (id, market)
);

-- One subscription at a time per subscriber; the free plan is a
-- subscription at price zero, so "who is on Free" is a plain query. A
-- subscriber keeps the price they subscribed at until a price migration
-- moves them (§4.3): price_minor is what they pay, not the list price.
create table subscription (
  id            bigint primary key,
  subscriber_id bigint not null,
  market        char(2) not null,
  currency      char(3) not null,
  plan_id       text not null,
  paid          boolean not null,
  price_minor   bigint not null,
  started_on    date not null,
  ended_on      date,
  billing_day   smallint not null check (billing_day between 1 and 28),
  constraint subscription_of_subscriber foreign key (subscriber_id, market) references subscriber (id, market),
  constraint subscription_market_currency foreign key (market, currency) references market (code, currency),
  constraint subscription_plan foreign key (plan_id, paid) references plan (id, paid),
  constraint subscription_price_matches_plan check ((paid and price_minor > 0) or (not paid and price_minor = 0)),
  constraint subscription_dates check (ended_on is null or ended_on > started_on),
  constraint subscription_one_at_a_time exclude using gist (subscriber_id with =, daterange(started_on, ended_on) with &&)
);

-- A simulated provider confirms that a person is a student; a verification
-- is valid for 12 months (§10).
create table student_verification (
  subscriber_id bigint not null references subscriber (id),
  verified_on   date not null,
  valid_until   date not null,
  provider      text not null check (provider = 'simulated'),
  primary key (subscriber_id, verified_on),
  constraint student_verification_twelve_months check (valid_until = verified_on + interval '12 months')
);

create table label (
  id      integer primary key,
  name    text not null unique check (length(name) between 1 and 80),
  country char(2) not null check (country ~ '^[A-Z]{2}$')
);

create table artist (
  id       integer primary key,
  name     text not null unique check (length(name) between 1 and 80),
  label_id integer not null references label (id),
  country  char(2) not null check (country ~ '^[A-Z]{2}$')
);

create table release (
  id          integer primary key,
  artist_id   integer not null references artist (id),
  title       text not null check (length(title) between 1 and 120),
  released_on date not null
);

-- Seconds of an artist played by a listener on a day, in the listener's
-- local calendar. Stage 7 measures the fan-campaign queries on this table
-- before and after indexes, monthly partitions and aggregates; here it has
-- only its primary key.
create table listening_day (
  subscriber_id bigint not null references subscriber (id),
  artist_id     integer not null references artist (id),
  day           date not null,
  seconds       integer not null check (seconds between 1 and 86400),
  primary key (subscriber_id, artist_id, day)
);

grant select on subscriber, subscription, student_verification, label, artist, release, listening_day to commerce_app;
grant insert on subscriber, subscription, student_verification to commerce_app;
grant update (ended_on) on subscription to commerce_app;
