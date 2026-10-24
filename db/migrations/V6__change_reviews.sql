-- What validation and submission leave behind (business book §6.4, §6.5,
-- §7.3), and when each change last moved.
--
-- A validation writes its report: the findings, the signatures the version
-- needs, and the difference in business words with the number of eligible
-- people counted when it was written (§6.5). A submission keeps the author's
-- reason, which a negative simulated contribution requires (§7.3, condition 4).
-- Both are written once and belong to one version: a new version starts
-- without them, as it starts without approvals.

alter table change add column updated_at timestamptz;

-- A change written without updated_at (a direct insert, as the database tests
-- do) starts with its creation time; the engine always sets it.
create function change_updated_at_default() returns trigger
language plpgsql as $$
begin
  new.updated_at := coalesce(new.updated_at, new.created_at);
  return new;
end $$;

create trigger change_updated_at_default
  before insert on change
  for each row execute function change_updated_at_default();

update change set updated_at = created_at where updated_at is null;
alter table change alter column updated_at set not null;

-- The console lists changes by their last move, newest first, by keyset.
create index change_by_update on change (updated_at desc, id desc);

-- Shared by the tables whose rows are written once and kept as they are.
create function written_once() returns trigger
language plpgsql as $$
begin
  raise exception 'rows of % are written once, never edited or deleted', tg_table_name using errcode = 'RL005';
end $$;

create table change_validation (
  id           bigint generated always as identity primary key,
  change_id    bigint not null,
  version      integer not null,
  validated_at timestamptz not null,
  validated_by text not null references person (id),
  valid        boolean not null,
  eligible     bigint not null check (eligible >= 0),
  sentence     text not null check (length(sentence) between 1 and 4000),
  report       jsonb not null check (jsonb_typeof(report) = 'object'),
  constraint change_validation_of_a_version foreign key (change_id, version) references change_version (change_id, version)
);

create index change_validation_latest on change_validation (change_id, version, id desc);

-- A validation looks at the current version of a draft: an older version, or
-- one already on its way to approval, has nothing left to validate.
create function change_validation_write() returns trigger
language plpgsql as $$
declare
  owner_state text;
  owner_version integer;
begin
  select state, current_version into owner_state, owner_version from change where id = new.change_id for update;
  if owner_state is distinct from 'draft' or owner_version is distinct from new.version then
    raise exception 'a validation looks at the current version of a draft (change %: %, version %)',
      new.change_id, owner_state, owner_version using errcode = 'RL005';
  end if;
  return new;
end $$;

create trigger change_validation_write
  before insert on change_validation
  for each row execute function change_validation_write();

create trigger change_validation_written_once
  before update or delete on change_validation
  for each row execute function written_once();

create trigger change_validation_no_truncate
  before truncate on change_validation
  for each statement execute function written_once();

create table change_submission (
  id            bigint generated always as identity primary key,
  change_id     bigint not null,
  version       integer not null,
  submitted_at  timestamptz not null,
  submitted_by  text not null references person (id),
  author_reason text check (author_reason is null or length(author_reason) between 1 and 2000),
  constraint change_submission_of_a_version foreign key (change_id, version) references change_version (change_id, version)
);

create index change_submission_latest on change_submission (change_id, version, id desc);

-- A submission sends the current version of a validated change to approval.
create function change_submission_write() returns trigger
language plpgsql as $$
declare
  owner_state text;
  owner_version integer;
begin
  select state, current_version into owner_state, owner_version from change where id = new.change_id for update;
  if owner_state is distinct from 'validated' or owner_version is distinct from new.version then
    raise exception 'a submission sends the current version of a validated change (change %: %, version %)',
      new.change_id, owner_state, owner_version using errcode = 'RL005';
  end if;
  return new;
end $$;

create trigger change_submission_write
  before insert on change_submission
  for each row execute function change_submission_write();

create trigger change_submission_written_once
  before update or delete on change_submission
  for each row execute function written_once();

create trigger change_submission_no_truncate
  before truncate on change_submission
  for each statement execute function written_once();

grant select, insert on change_validation, change_submission to commerce_app;
grant update (updated_at) on change to commerce_app;
