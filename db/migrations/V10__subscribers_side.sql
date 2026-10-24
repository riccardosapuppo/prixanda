-- The subscriber's side (business book §4.3, §4.5, §6.1, §10, §14.1, §14.5):
-- subscriptions confirmed from a quote, their demonstration receipts, student
-- verifications with the provider's reference, and the demo's listeners.
-- Expansion only: every column added is nullable or has a default, and the
-- audit log's list of roles only grows.

-- A subscriber acts on their own account (a student verification, a
-- confirmed quote) and is the author of those events in the audit log.
alter table audit_event drop constraint audit_event_actor_role_check;
alter table audit_event add constraint audit_event_actor_role_check
  check (actor_role in ('marketing', 'commercial_lead', 'finance', 'catalog_manager', 'on_call', 'auditor', 'system',
                        'subscriber'));

-- A subscription confirmed from a quote names it, and an offer's
-- subscription names the offer and how many months it lasts at its price.
-- After those months the list price in force at that time applies (§6.1).
alter table subscription
  add column quote_id text references quote (id),
  add column offer_change_id bigint references change (id),
  add column offer_months integer check (offer_months between 1 and 36),
  add constraint subscription_offer_and_its_months check ((offer_change_id is null) = (offer_months is null)),
  add constraint subscription_offer_from_a_quote check (offer_change_id is null or quote_id is not null);

-- A quote is confirmed once.
create unique index subscription_one_per_quote on subscription (quote_id) where quote_id is not null;
-- Redemptions of an offer, counted against its cap.
create index subscription_by_offer on subscription (offer_change_id) where offer_change_id is not null;

-- Identifiers of the subscriptions the engine writes. The generated data
-- numbers its own from 1; these start far above any it writes.
create sequence subscription_id_seq start with 1000000000;
grant usage on sequence subscription_id_seq to commerce_app;

alter table student_verification add column reference text
  check (reference is null or reference ~ '^[a-z]+-[a-z]+-[0-9a-f]{8,64}$');

-- What the simulated payment provider gives back: a receipt that says it is a
-- demonstration. No money moved; demonstration can only be true.
create table receipt (
  id                 text primary key check (id ~ '^r_[0-9a-f]{32}$'),
  subscription_id    bigint not null references subscription (id),
  quote_id           text not null references quote (id),
  subscriber_id      bigint not null references subscriber (id),
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  issued_at          timestamptz not null,
  provider           text not null check (provider = 'simulated'),
  provider_reference text not null check (length(provider_reference) between 1 and 100),
  demonstration      boolean not null default true check (demonstration),
  note               text not null check (length(note) between 1 and 400),
  unique (subscription_id)
);

create trigger receipt_written_once before update or delete on receipt
  for each row execute function written_once();
create trigger receipt_no_truncate before truncate on receipt
  for each statement execute function written_once();

-- The listeners the site's entrance offers, chosen by the generator: each
-- shows one situation, and its label says the data is simulated. student
-- tells the simulated verifier whether this listener has a student record.
create table demo_listener (
  subscriber_id bigint primary key references subscriber (id),
  position      smallint not null unique check (position > 0),
  title         text not null check (length(title) between 1 and 80),
  label         text not null check (length(label) between 1 and 400 and label like 'Simulated listener.%'),
  student       boolean not null
);

grant select on demo_listener to commerce_app;
grant select, insert on receipt to commerce_app;
