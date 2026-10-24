-- Plans not wired to music (business book §14.7): a second company, in the
-- tests, sells seat-based plans through the same flows. Two assumptions of
-- V1 belonged to the music service and not to the platform:
--
-- * a plan had at most 10 seats (a family's); a business plan has 25 or
--   more: up to 1000 now;
-- * the plan a subscriber is on without paying was called 'free'; it is
--   now whichever plan is not paid, and a business has one at most, so that
--   the engine can always tell which it is.

alter table plan drop constraint plan_seats_check;
alter table plan add constraint plan_seats_check check (seats between 1 and 1000);

create unique index plan_one_unpaid on plan ((true)) where not paid;
