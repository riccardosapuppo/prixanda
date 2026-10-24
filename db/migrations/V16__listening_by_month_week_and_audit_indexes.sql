-- The queries that matter on the full data (business book §14.2), made
-- cheaper and measured before and after (npm run measure):
--
-- * a fan campaign's audience: the listeners who played an artist for more
--   than some hours in the last 30 days, counted per market;
-- * whether one listener is in that audience, which a quote asks;
-- * the audit log's pages, by keyset, filtered by action, subject or actor.
--
-- Listening becomes a table partitioned by month, with an index by artist and
-- day, and a weekly sum per listener and artist that its inserts keep: the
-- last 30 days are a few whole weeks from the sums and the days at either end.
-- Listening is loaded, never edited: the sums stay true because rows are only
-- added. The audit log gets an index for each filter of its pages.

alter table listening_day rename to listening_day_unpartitioned;
alter table listening_day_unpartitioned rename constraint listening_day_pkey to listening_day_unpartitioned_pkey;

create table listening_day (
  subscriber_id bigint not null references subscriber (id),
  artist_id     integer not null references artist (id),
  day           date not null,
  seconds       integer not null check (seconds between 1 and 86400),
  primary key (subscriber_id, artist_id, day)
) partition by range (day);

-- One partition per month of the platform's life so far and the next year,
-- and a default one that keeps any other day valid. A month's partition is
-- added before the month begins (docs/runbook.md); a row of a month without
-- one waits in the default partition.
create function listening_month(first_day date) returns void
language plpgsql as $$
declare
  name text := 'listening_day_' || to_char(first_day, 'YYYY_MM');
begin
  if first_day <> date_trunc('month', first_day)::date then
    raise exception 'a month starts on its first day, not on %', first_day;
  end if;
  execute format('create table %I partition of listening_day for values from (%L) to (%L)',
                 name, first_day, (first_day + interval '1 month')::date);
end $$;

select listening_month(month::date) from generate_series(date '2025-01-01', date '2027-12-01', interval '1 month') as month;
create table listening_day_other partition of listening_day default;

-- Each listener's seconds of an artist per week (weeks start on Monday),
-- kept by every insert into listening_day, in the inserting statement.
create table listening_week (
  artist_id     integer not null references artist (id),
  week          date not null check (extract(isodow from week) = 1),
  subscriber_id bigint not null references subscriber (id),
  seconds       bigint not null check (seconds > 0),
  primary key (artist_id, week, subscriber_id) include (seconds)
);

create function listening_week_add() returns trigger
language plpgsql as $$
begin
  insert into listening_week (artist_id, week, subscriber_id, seconds)
    select artist_id, date_trunc('week', day)::date, subscriber_id, sum(seconds) from added group by 1, 2, 3
  on conflict (artist_id, week, subscriber_id) do update set seconds = listening_week.seconds + excluded.seconds;
  return null;
end $$;

create trigger listening_week_add
  after insert on listening_day
  referencing new table as added
  for each statement execute function listening_week_add();

-- RL013: listening is only ever added, so that its weekly sums stay true.
create function listening_added_only() returns trigger
language plpgsql as $$
begin
  raise exception 'listening is only ever added: % is refused', lower(tg_op) using errcode = 'RL013';
end $$;

create trigger listening_day_added_only before update or delete on listening_day
  for each row execute function listening_added_only();
create trigger listening_day_no_truncate before truncate on listening_day
  for each statement execute function listening_added_only();
create trigger listening_week_added_only before update or delete on listening_week
  for each row when (pg_trigger_depth() = 0) execute function listening_added_only();
create trigger listening_week_no_truncate before truncate on listening_week
  for each statement execute function listening_added_only();

-- The rows so far move into the partitions, and the weekly sums follow.
insert into listening_day select subscriber_id, artist_id, day, seconds from listening_day_unpartitioned;
drop table listening_day_unpartitioned;

-- A fan campaign's audience reads one artist's days and weeks.
create index listening_day_by_artist on listening_day (artist_id, day) include (subscriber_id, seconds);

grant select on listening_day, listening_week to commerce_app;

-- The audit log's pages filtered by one column, newest first (ListEvents).
create index audit_event_by_action on audit_event (action, seq);
create index audit_event_by_subject on audit_event (subject, seq);
create index audit_event_by_actor on audit_event (actor, seq);
