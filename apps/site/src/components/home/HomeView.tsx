"use client";
// The home of the service. It opens on music: a record from the label of the
// market the visitor is looking at, and that label's listening session.
// Then the promise to the artists, plan by plan, in a band of its own; then
// the plans, the one chosen open on where its money goes; then the labels'
// new records and their listening sessions.
//
// The market and the plan are in the address (?market=FR&plan=duo), so a
// link can open the page on a plan. A listener who has entered and comes on
// an address that names no market sees their own market's prices.
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useMarkets, useMe, usePlans, usePrefetchPlans } from "../../data/hooks.ts";
import { DEFAULT_MARKET, isSiteMarket, marketFromQuery, type SiteMarket } from "../../data/markets.ts";
import { ArtistsPromise } from "./ArtistsPromise.tsx";
import { Releases, Sessions } from "./Catalogue.tsx";
import { Hero } from "./Hero.tsx";
import { FIRST_PLAN, planFromQuery } from "./plan-order.ts";
import { Plans } from "./Plans.tsx";

export function HomeView() {
  const search = useSearchParams();
  const askedMarket = marketFromQuery(search);
  const askedPlan = planFromQuery(search);
  const [market, setMarket] = useState<SiteMarket>(askedMarket ?? DEFAULT_MARKET);
  const [plan, setPlan] = useState(askedPlan ?? FIRST_PLAN);
  // Whether the visitor has picked a market here, and changed anything at all:
  // what changes may then enter (never on arrival, never from the keyboard).
  const [picked, setPicked] = useState(askedMarket !== null);
  const [moved, setMoved] = useState(false);
  const me = useMe();
  const own = me.data?.market;
  const shown = usePlans(market);
  const markets = useMarkets();
  usePrefetchPlans(shown.isSuccess);

  // An address with a section in it (/#sessions) is opened before the page has
  // its figures, so the browser finds nothing to scroll to: once the figures
  // above are in, the page goes to the section itself, once.
  const settled = !shown.isPending && !markets.isPending;
  const arrived = useRef(false);
  useEffect(() => {
    if (!settled || arrived.current) return;
    arrived.current = true;
    let id = "";
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return; // an address that is not one names no section
    }
    if (id !== "") document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [settled]);

  // An address that names a market or a plan wins (a link followed on this page, say).
  useEffect(() => {
    if (askedMarket !== null) {
      setMarket(askedMarket);
      setPicked(true);
    }
  }, [askedMarket]);
  useEffect(() => {
    if (askedPlan !== null) setPlan(askedPlan);
  }, [askedPlan]);
  useEffect(() => {
    if (!picked && own !== undefined && isSiteMarket(own)) setMarket(own);
  }, [picked, own]);

  const remember = (nextMarket: SiteMarket, nextPlan: string) => {
    const address = new URL(window.location.href);
    address.searchParams.set("market", nextMarket);
    address.searchParams.set("plan", nextPlan);
    window.history.replaceState(null, "", `${address.pathname}${address.search}${address.hash}`);
  };

  return (
    <>
      <Hero market={market} changed={moved} />
      <ArtistsPromise market={market} />
      <Plans
        market={market}
        plan={plan}
        moved={moved}
        onMarket={(next) => {
          setMarket(next);
          setPicked(true);
          setMoved(true);
          remember(next, plan);
        }}
        onPlan={(next) => {
          setPlan(next);
          setMoved(true);
          remember(market, next);
        }}
      />
      <Releases />
      <Sessions />
    </>
  );
}
