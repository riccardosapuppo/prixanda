-- Price migrations (business book §8, §14.3): a higher price for a plan in a
-- market, for new subscribers from a date, and for the existing ones by the
-- rules of their market. Those rules have two parts never mixed (§8.1): what
-- the law requires, with its sources, and what Sonequo chose, a setting of the
-- market and never law (§8.6).

create table price_change_policy (
  market            char(2) primary key references market (code),
  -- The law: consent (the subscriber must say yes, silence is no) or notice
  -- (told in advance, free to leave before the new price applies).
  legal_requirement text not null check (legal_requirement in ('consent', 'notice')),
  legal_basis       text not null check (length(legal_basis) between 1 and 2000),
  legal_sources     jsonb not null check (jsonb_typeof(legal_sources) = 'array' and jsonb_array_length(legal_sources) >= 1),
  -- The choices: the length of the window, and what happens when it ends.
  window_days       smallint not null check (window_days between 1 and 365),
  after_window      text not null
                    check (after_window in ('move_to_free', 'end_at_period_end', 'keep_old_price', 'new_price')),
  commercial_choice text not null check (length(commercial_choice) between 1 and 400),
  alternatives      jsonb not null default '[]' check (jsonb_typeof(alternatives) = 'array'),
  -- Without consent the price never rises: a consent market chooses what
  -- happens to those who did not say yes; a notice market applies the price.
  constraint price_change_policy_choice_fits_the_law check (
    (legal_requirement = 'consent') = (after_window in ('move_to_free', 'end_at_period_end', 'keep_old_price')))
);

insert into price_change_policy (market, legal_requirement, legal_basis, legal_sources, window_days, after_window,
                                 commercial_choice, alternatives) values
  ('DE', 'consent',
   'Terms letting a streaming service raise the price of a running subscription at its own discretion unreasonably '
   'disadvantage consumers (German Civil Code, § 307(1), first sentence): the service can ask for consent instead. '
   'Sonequo asks existing subscribers for their active consent before an increase applies, and silence is not consent.',
   '["Kammergericht (Berlin), two judgments of 15 November 2023, press release 27/2023", '
   '"Bundesgerichtshof, decisions of 30 January 2025 and 27 February 2025: the judgments are final", '
   '"Bundesgerichtshof, 1 October 2026, press release 184/2026", "German Civil Code (BGB), § 307(1)"]',
   45, 'move_to_free',
   'When the period already paid at the consent deadline runs out, the account moves to the free plan, and keeps '
   'its playlists and library.',
   '["End the paid subscription at the end of the billing period", "Keep the old price until a stated date"]'),
  ('IT', 'notice',
   'A term letting the trader change the contract without a justified reason stated in it, or raise the price without '
   'the consumer being able to withdraw, is presumed unfair unless the trader proves otherwise. Sonequo states the reasons '
   'in its terms, gives advance notice, and lets the customer withdraw before the new price applies.',
   '["Consumer Code (Legislative Decree 206/2005), art. 33(2)(m) and (o)"]',
   30, 'new_price',
   'Thirty days of notice, with the reason for the change; the subscriber may leave before the new price applies, with no exit fee.',
   '[]'),
  ('FR', 'notice',
   'A term reserving to the trader the right to change the price unilaterally is prohibited; in a contract of indefinite '
   'duration the price may change if the consumer is told within a reasonable time, so as to be able to terminate. Sonequo '
   'applies increases after advance notice, with the option to terminate before the new price applies.',
   '["Consumer Code, art. R. 212-1, 3°", "Consumer Code, art. R. 212-4"]',
   30, 'new_price',
   'Thirty days of notice; the subscriber may terminate before the new price applies.',
   '[]'),
  ('GB', 'notice',
   'Terms letting the trader alter the contract without a valid reason, or raise the price without a right to cancel, '
   'may be regarded as unfair; advance notice and a genuine freedom to exit make a price-variation term more likely '
   'to be fair. This is not a legal safe harbour. Sonequo applies increases after advance notice, with the option to '
   'cancel before the new price applies.',
   '["Consumer Rights Act 2015, Schedule 2, paras 11 and 15, and section 63", '
   '"CMA37, unfair contract terms guidance, 22 July 2026"]',
   30, 'new_price',
   'Thirty days of notice; the subscriber may cancel before the new price applies.',
   '[]');

-- One request for each existing subscription of the plan in the market, when
-- the migration starts: a request for consent, or a notice.
create table price_change_request (
  id                bigint generated always as identity primary key,
  change_id         bigint not null references change (id),
  subscription_id   bigint not null references subscription (id),
  subscriber_id     bigint not null references subscriber (id),
  market            char(2) not null references market (code),
  plan_id           text not null references plan (id),
  kind              text not null check (kind in ('consent', 'notice')),
  -- What the subscription costs without the change, and the new price.
  old_price_minor   bigint not null check (old_price_minor > 0),
  new_price_minor   bigint not null,
  sent_at           timestamptz not null,
  window_ends_local timestamp not null,
  window_ends_at    timestamptz not null,
  state             text not null default 'waiting'
                    check (state in ('waiting', 'accepted', 'declined', 'lapsed', 'new_price')),
  answer            text check (answer in ('yes', 'no')),
  answered_at       timestamptz,
  -- The first day charged at the new price, once decided.
  new_price_from    date,
  -- The day the subscription leaves the paid plan because of the change.
  leaves_on         date,
  -- When the end of the window was acted on.
  settled_at        timestamptz,
  request_id        text not null check (length(request_id) between 1 and 100),
  unique (change_id, subscription_id),
  constraint price_change_request_higher check (new_price_minor > old_price_minor),
  constraint price_change_request_answered_once check ((answer is null) = (answered_at is null)),
  constraint price_change_request_window check (window_ends_at > sent_at),
  constraint price_change_request_kind_states check (
    (kind = 'consent' and state <> 'new_price') or (kind = 'notice' and state not in ('accepted', 'lapsed'))),
  constraint price_change_request_said check (
    (state <> 'accepted' or answer = 'yes') and (state <> 'declined' or answer = 'no') and (state <> 'lapsed' or answer is null)),
  constraint price_change_request_dated check (state not in ('accepted', 'new_price') or new_price_from is not null)
);

create index price_change_request_by_subscription on price_change_request (subscription_id);
create index price_change_request_open on price_change_request (window_ends_at) where settled_at is null;

-- RL011: a request moves in a way the migration does not.
create function price_change_request_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a price change request is never deleted' using errcode = 'RL011';
  end if;
  if (new.change_id, new.subscription_id, new.subscriber_id, new.market, new.plan_id, new.kind, new.old_price_minor,
      new.new_price_minor, new.sent_at, new.window_ends_local, new.window_ends_at, new.request_id)
     is distinct from
     (old.change_id, old.subscription_id, old.subscriber_id, old.market, old.plan_id, old.kind, old.old_price_minor,
      old.new_price_minor, old.sent_at, old.window_ends_local, old.window_ends_at, old.request_id) then
    raise exception 'a price change request keeps what it asked, to whom and until when' using errcode = 'RL011';
  end if;
  if old.state <> 'waiting' and new.state <> old.state then
    raise exception 'price change request % is %, and stays so', old.id, old.state using errcode = 'RL011';
  end if;
  if old.answer is not null and (new.answer, new.answered_at) is distinct from (old.answer, old.answered_at) then
    raise exception 'price change request % was answered, once', old.id using errcode = 'RL011';
  end if;
  if (old.new_price_from is not null and new.new_price_from is distinct from old.new_price_from)
     or (old.leaves_on is not null and new.leaves_on is distinct from old.leaves_on)
     or (old.settled_at is not null and new.settled_at is distinct from old.settled_at) then
    raise exception 'price change request % keeps the dates it was settled with', old.id using errcode = 'RL011';
  end if;
  return new;
end $$;

create trigger price_change_request_guard
  before update or delete on price_change_request
  for each row execute function price_change_request_guard();

-- The listeners' inbox: what the outbox told them (a request for consent, a
-- notice, an outcome), one row per message however often it arrived.
create table subscriber_notice (
  message_id    bigint primary key references outbox_message (id),
  subscriber_id bigint not null references subscriber (id),
  kind          text not null check (kind in ('price_change.request', 'price_change.outcome')),
  subject       text not null check (length(subject) between 1 and 200),
  body          text not null check (length(body) between 1 and 4000),
  received_at   timestamptz not null,
  arrivals      integer not null default 1 check (arrivals >= 1)
);

create index subscriber_notice_by_subscriber on subscriber_notice (subscriber_id, received_at desc);

create trigger subscriber_notice_arrivals_only before update or delete on subscriber_notice
  for each row execute function arrivals_only();

-- A price migration launches like a list price; the outbox carries the requests and their outcomes.
alter table launch drop constraint launch_kind_check;
alter table launch add constraint launch_kind_check check (kind in ('offer', 'list_price', 'price_migration'));
alter table outbox_message drop constraint outbox_message_topic_check;
alter table outbox_message add constraint outbox_message_topic_check
  check (topic in ('catalog.published', 'payment.charge', 'price_change.request', 'price_change.outcome'));

grant select on price_change_policy to commerce_app;
grant select, insert on price_change_request, subscriber_notice to commerce_app;
grant update (state, answer, answered_at, new_price_from, leaves_on, settled_at) on price_change_request to commerce_app;
grant update (arrivals) on subscriber_notice to commerce_app;
