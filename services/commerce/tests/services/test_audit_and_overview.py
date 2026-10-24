"""The audit log through the contract (business book §11), the console's
home and the demo's people (§12)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from commerce.engine.errors import InvalidArgument, PermissionDenied
from commerce.v1 import audit_pb2, common_pb2, overview_pb2, quotes_pb2, subscriptions_pb2
from engine_support import (
    AUDITOR, CATALOG, FINANCE, LEAD, MARKETING, ON_CALL, PUBLIC, create, family_rise, scheduled, student_autumn, submitted,
)

REFUSAL = common_pb2.RefusalCode


async def some_history(world) -> None:
    for n in range(3):
        world.clock.advance(minutes=1)
        await create(world, student_autumn(title=f"Offer {n}"))


async def test_events_come_newest_first_by_keyset_and_filter_exactly(world):
    await some_history(world)
    first = await world.call("ListEvents", audit_pb2.ListEventsRequest(page=common_pb2.PageRequest(size=2)), CATALOG)
    assert [e.seq for e in first.events] == [3, 2] and first.page.next == "2"
    rest = await world.call("ListEvents", audit_pb2.ListEventsRequest(page=common_pb2.PageRequest(size=2, after="2")), CATALOG)
    assert [e.seq for e in rest.events] == [1] and rest.page.next == ""
    event = first.events[0]
    assert (event.actor, event.actor_role, event.action, event.subject) == ("marketing-1", "marketing", "change.created", "change:3")
    assert event.at == "2026-10-24T08:45:00Z" and '"version": 1' in event.body_json and len(event.hash) == 32
    filtered = await world.call("ListEvents", audit_pb2.ListEventsRequest(subject="change:2"), ON_CALL)
    assert [e.seq for e in filtered.events] == [2]
    with pytest.raises(InvalidArgument):
        await world.call("ListEvents", audit_pb2.ListEventsRequest(page=common_pb2.PageRequest(after="two")), ON_CALL)


async def test_the_chain_verifies_and_leads_to_the_head_exported_earlier(world):
    await some_history(world)
    exported = (await world.call("ExportHead", audit_pb2.ExportHeadRequest(), AUDITOR)).head
    assert exported.seq == 3
    [event] = await world.events("audit.exported")
    assert event["actor"] == "auditor-1" and f'"head": "{exported.hash.hex()}"' in event["body"]
    report = await world.call("VerifyChain", audit_pb2.VerifyChainRequest(anchor=exported), AUDITOR)
    assert report.ok and report.events == 4 and report.head.seq == 4


async def test_a_rewritten_event_breaks_the_chain(world):
    await some_history(world)
    await world.owner.execute("alter table audit_event disable trigger audit_event_no_change")
    await world.owner.execute("update audit_event set reason = 'rewritten' where seq = 2")
    await world.owner.execute("alter table audit_event enable trigger audit_event_no_change")
    report = await world.call("VerifyChain", audit_pb2.VerifyChainRequest(), ON_CALL)
    assert not report.ok and report.broken_at == 2 and "content" in report.why and report.head.seq == 1


async def test_a_head_beyond_the_chain_means_events_were_removed(world):
    await some_history(world)
    anchor = audit_pb2.ChainHead(seq=9, hash=b"\x07" * 32)
    report = await world.call("VerifyChain", audit_pb2.VerifyChainRequest(anchor=anchor), AUDITOR)
    assert not report.ok and "removed" in report.why


async def test_who_verifies_and_who_exports(world):
    await some_history(world)
    for who in (MARKETING, FINANCE, CATALOG):
        with pytest.raises(PermissionDenied):
            await world.call("VerifyChain", audit_pb2.VerifyChainRequest(), who)
        response = await world.call("ExportHead", audit_pb2.ExportHeadRequest(), who)
        assert response.refusal.code == REFUSAL.REFUSAL_CODE_ROLE_NOT_ALLOWED
    with pytest.raises(InvalidArgument):
        await world.call("VerifyChain", audit_pb2.VerifyChainRequest(anchor=audit_pb2.ChainHead(seq=1, hash=b"short")), AUDITOR)


async def test_an_empty_log_has_no_head_to_export(world):
    response = await world.call("ExportHead", audit_pb2.ExportHeadRequest(), AUDITOR)
    assert response.refusal.code == REFUSAL.REFUSAL_CODE_INVALID
    assert (await world.call("VerifyChain", audit_pb2.VerifyChainRequest(), AUDITOR)).ok


async def test_the_home_counts_subscribers_on_each_market_s_day(world):
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), MARKETING)
    paying = {(c.market, c.plan): c.count for c in home.paying_subscribers}
    assert paying == {("DE", "family"): 1, ("GB", "individual"): 1, ("IT", "individual"): 1, ("IT", "student"): 1}
    free = {(c.market, c.plan): c.count for c in home.free_listeners}
    assert free == {("DE", "free"): 3, ("FR", "free"): 1, ("IT", "free"): 4}
    assert home.exchange_rate_note == "1 EUR = 0.83728 GBP (ECB reference rate, 23 October 2026)"


async def test_revenue_goes_only_to_finance_and_the_commercial_lead(world):
    for who in (FINANCE, LEAD):
        home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), who)
        revenue = {r.market: (r.revenue.amount_minor, r.revenue.currency, r.revenue_eur.amount_minor) for r in home.monthly_revenue}
        # Net of VAT: Family in Germany 1596; Individual in Italy 860 and Student 475; Individual in the UK £7.91 = €9.45.
        assert revenue == {"DE": (1596, "EUR", 1596), "FR": (0, "EUR", 0), "GB": (791, "GBP", 945), "IT": (1335, "EUR", 1335)}
        assert home.monthly_revenue_eur.amount_minor == 1596 + 945 + 1335
        assert home.monthly_top_ups.amount_minor == 15  # the Italian Student, below the floor
    for who in (MARKETING, CATALOG, ON_CALL, AUDITOR):
        home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), who)
        assert list(home.monthly_revenue) == [] and not home.HasField("monthly_revenue_eur") and not home.HasField("monthly_top_ups")


async def test_the_home_lists_what_waits_and_what_launches_this_week(world):
    waiting = await submitted(world, student_autumn())
    ready = await scheduled(world, family_rise(starts_local="2026-10-30T00:00"), LEAD, FINANCE)
    later = await scheduled(world, family_rise(market="FR", amount=common_pb2.Money(amount_minor=1_949, currency="EUR"),
                                               starts_local="2026-12-01T00:00"), LEAD, FINANCE)
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(), ON_CALL)
    assert [c.id for c in home.waiting_for_approval] == [waiting.id]
    launches = [(l.change_id, l.starts.market, l.starts.local, l.starts.utc, l.at_risk) for l in home.launches_next_7_days]
    assert launches == [(waiting.id, "IT", "2026-10-26T09:00", "2026-10-26T08:00:00Z", True),
                        (ready.id, "DE", "2026-10-30T00:00", "2026-10-29T23:00:00Z", False)]
    assert later.id not in [l.change_id for l in home.launches_next_7_days]
    assert home.launches_next_7_days[0].risk.startswith("Not approved yet")
    assert list(home.incidents_today) == []


async def test_the_home_at_an_instant_of_the_past(world):
    home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(at="2026-01-15T12:00:00Z"), FINANCE)
    paying = {(c.market, c.plan): c.count for c in home.paying_subscribers}
    assert paying == {}
    with pytest.raises(InvalidArgument):
        await world.call("GetOverview", overview_pb2.GetOverviewRequest(at="15 January"), FINANCE)


async def test_the_people_of_the_demo_are_listed_for_the_console_s_entry(world):
    people = (await world.call("ListPeople", overview_pb2.ListPeopleRequest(), PUBLIC)).people
    by_id = {p.id: (p.label, list(p.roles)) for p in people}
    assert len(by_id) == 9
    assert by_id["finance-1"] == ("Finance", [common_pb2.ROLE_FINANCE])
    assert by_id["lead-and-finance-1"][1] == [common_pb2.ROLE_COMMERCIAL_LEAD, common_pb2.ROLE_FINANCE]


async def test_the_revenue_counts_each_subscription_at_what_it_costs_on_the_day(world):
    # The verified student takes the Student Autumn Pass on 26 October: 2,99 € a month for three months, then the list
    # price of 5,79 € from 26 January 2027, as the account says. The home's revenue follows the same months.
    change = await scheduled(world, student_autumn(), MARKETING, FINANCE)
    world.clock.at = datetime(2026, 10, 26, 7, 59, 30, tzinfo=UTC)
    await world.engine.run_launches()
    world.clock.at = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
    quote = (await world.call("GetQuote", quotes_pb2.GetQuoteRequest(plan="student", market="IT", offer_id=change.id,
                                                                      subscriber_id=101), PUBLIC)).quote
    await world.call("ConfirmQuote", subscriptions_pb2.ConfirmQuoteRequest(quote_id=quote.quote_id, subscriber_id=101), PUBLIC)

    async def italy(at: str) -> tuple[int, int]:
        home = await world.call("GetOverview", overview_pb2.GetOverviewRequest(at=at), FINANCE)
        return {r.market: r.revenue.amount_minor for r in home.monthly_revenue}["IT"], home.monthly_top_ups.amount_minor

    # Net of VAT: Individual 860 and Student 475 as before, and the pass at 2,99 € is 245, with a top-up of 153.
    assert await italy("2026-11-15T12:00:00Z") == (860 + 475 + 245, 15 + 153)
    world.clock.at = datetime(2027, 2, 1, 12, 0, tzinfo=UTC)
    account = (await world.call("GetAccount", subscriptions_pb2.GetAccountRequest(subscriber_id=101), PUBLIC)).account
    assert account.subscription.price.amount_minor == 579
    # After its three months the pass costs the list price: 475 net, and a top-up of 15 like any Student.
    assert await italy("2027-02-01T12:00:00Z") == (860 + 475 + 475, 15 + 15)
