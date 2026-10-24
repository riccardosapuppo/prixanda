-- Versioned changes and their approvals (business book §6.3, §7).
--
-- What the database guarantees on its own, so that a bug in the engine does
-- not open the door (§7.4):
--   * a version never changes once written, and its fingerprint is computed
--     here, from its content, not taken from the caller;
--   * an approval names one version, its author and its fingerprint, and is
--     given only to the current version of a change in approval;
--   * the approver is not the author, holds the role they sign with, and gives
--     at most one signature to a version;
--   * a change moves only along the states of the book, nothing reaches
--     "approved" without a signature, and a new version starts as a draft:
--     approvals never carry over.

create table change (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('offer', 'list_price', 'entitlement', 'price_migration', 'prepaid')),
  title           text not null check (length(title) between 1 and 200),
  created_by      text not null references person (id),
  created_at      timestamptz not null,
  state           text not null default 'draft'
                  check (state in ('draft', 'validated', 'in_approval', 'approved', 'scheduled',
                                   'active', 'ended', 'suspended', 'cancelled')),
  state_reason    text check (state_reason is null or length(state_reason) between 1 and 2000),
  current_version integer,
  constraint change_reason_when_stopped check (state not in ('suspended', 'cancelled') or state_reason is not null)
);

create table change_version (
  change_id    bigint not null references change (id),
  version      integer not null check (version > 0),
  author       text not null references person (id),
  created_at   timestamptz not null,
  content      jsonb not null check (jsonb_typeof(content) = 'object'),
  content_hash bytea not null check (length(content_hash) = 32),
  primary key (change_id, version),
  -- What an approval points to: the version, its author and its fingerprint.
  unique (change_id, version, author, content_hash)
);

alter table change add constraint change_current_version_exists
  foreign key (id, current_version) references change_version (change_id, version)
  deferrable initially deferred;

create function change_version_write() returns trigger
language plpgsql as $$
declare
  owner_state text;
  last_version integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'a version is never edited or deleted: write the next one' using errcode = 'RL004';
  end if;
  select state into owner_state from change where id = new.change_id for update;
  if owner_state not in ('draft', 'validated', 'in_approval', 'approved') then
    raise exception 'a % change takes no new versions: start a new change', owner_state using errcode = 'RL004';
  end if;
  select max(version) into last_version from change_version where change_id = new.change_id;
  if new.version <> coalesce(last_version, 0) + 1 then
    raise exception 'version % of change % does not follow %', new.version, new.change_id, coalesce(last_version, 0)
      using errcode = 'RL004';
  end if;
  new.content_hash := sha256(convert_to(new.content::text, 'UTF8'));
  return new;
end $$;

create trigger change_version_write
  before insert or update or delete on change_version
  for each row execute function change_version_write();

create table approval (
  change_id    bigint not null,
  version      integer not null,
  author       text not null,
  content_hash bytea not null,
  approver     text not null,
  role         text not null check (role in ('commercial_lead', 'finance')),
  decided_at   timestamptz not null,
  primary key (change_id, version, role),
  constraint approval_names_a_version foreign key (change_id, version, author, content_hash)
    references change_version (change_id, version, author, content_hash),
  constraint approval_signed_with_held_role foreign key (approver, role) references person_role (person_id, role),
  constraint approval_not_by_author check (approver <> author),
  constraint approval_one_signature_per_person unique (change_id, version, approver)
);

create function approval_write() returns trigger
language plpgsql as $$
declare
  owner_state text;
  owner_version integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'an approval is never edited or withdrawn' using errcode = 'RL003';
  end if;
  select state, current_version into owner_state, owner_version from change where id = new.change_id for update;
  if owner_state is distinct from 'in_approval' or owner_version is distinct from new.version then
    raise exception 'approvals go to the current version of a change in approval (change %: %, version %)',
      new.change_id, owner_state, owner_version using errcode = 'RL003';
  end if;
  return new;
end $$;

create trigger approval_write
  before insert or update or delete on approval
  for each row execute function approval_write();

create function change_transition() returns trigger
language plpgsql as $$
declare
  allowed text[];
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.current_version is not null then
      raise exception 'a change starts as a draft, before its first version' using errcode = 'RL002';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a change is never deleted' using errcode = 'RL002';
  end if;
  if new.kind <> old.kind or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'a change keeps its kind, author and creation time' using errcode = 'RL002';
  end if;

  -- A new version: the only move that may happen from several states, and it
  -- always goes back to draft, because approvals never carry over (§7.2).
  if new.current_version is distinct from old.current_version then
    if new.current_version is null or new.current_version <= coalesce(old.current_version, 0) then
      raise exception 'versions only move forward' using errcode = 'RL002';
    end if;
    if old.state not in ('draft', 'validated', 'in_approval', 'approved') or new.state <> 'draft' then
      raise exception 'a new version returns a % change to draft, and only before it is scheduled', old.state
        using errcode = 'RL002';
    end if;
    return new;
  end if;

  if new.state = old.state then
    if new.title <> old.title and new.state <> 'draft' then
      raise exception 'the title changes only in draft' using errcode = 'RL002';
    end if;
    return new;
  end if;

  allowed := case old.state
    when 'draft'       then array['validated']
    when 'validated'   then array['in_approval']
    when 'in_approval' then array['approved', 'draft']
    when 'approved'    then array['scheduled']
    when 'scheduled'   then array['active', 'cancelled']
    when 'active'      then array['ended', 'suspended']
    else array[]::text[]
  end;
  if not (new.state = any (allowed)) then
    raise exception 'a change cannot go from % to %', old.state, new.state using errcode = 'RL002';
  end if;
  if new.current_version is null then
    raise exception 'a change needs a version before it moves on' using errcode = 'RL002';
  end if;
  if old.state = 'in_approval' and new.state = 'draft' and new.state_reason is null then
    raise exception 'a rejection carries its reason' using errcode = 'RL002';
  end if;
  if new.state = 'approved'
     and not exists (select from approval a where a.change_id = new.id and a.version = new.current_version) then
    raise exception 'nothing is approved without the signature of someone other than its author' using errcode = 'RL003';
  end if;
  return new;
end $$;

create trigger change_transition
  before insert or update or delete on change
  for each row execute function change_transition();

alter table plan_entitlement add constraint plan_entitlement_change foreign key (change_id) references change (id);

grant select, insert on change, change_version, approval to commerce_app;
grant update (title, state, state_reason, current_version) on change to commerce_app;
