"use client";
// The opening of the home: music first. A record from the label of the
// market the visitor is looking at, printed large, its liner note, and that
// label's listening session, ready to play. A new market brings its own
// label's record, with a short cross-fade.
import { Icon } from "design/icon";
import Link from "next/link";
import { copy } from "../../content/copy.ts";
import { type Label, runningTime, sessionOf, slug } from "../../content/editorial.ts";
import { useLabels, useMarketName, useReleases } from "../../data/hooks.ts";
import type { SiteMarket } from "../../data/markets.ts";
import { Cover, Sleeves } from "../art/Cover.tsx";
import { TECHNIQUE } from "../art/covers.ts";
import { sessionHref } from "./Catalogue.tsx";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function Hero({ market, changed }: { readonly market: SiteMarket; readonly changed: boolean }) {
  const labels = useLabels();
  const releases = useReleases();
  const marketNameOf = useMarketName();
  const label: Label | undefined = labels.data.find((each) => each.country === market) ?? labels.data[0];
  if (!label) return null;
  const session = sessionOf(label, releases.data);
  const record = session.records[0];
  if (!record) return null;
  // Nothing beside the label while the markets are read: never the market's code.
  const marketName = marketNameOf(market);
  const technique = TECHNIQUE[label.name] ?? "linocut";
  const enter = changed ? " is-entering" : "";

  return (
    <section className="hero wrap" aria-labelledby="home-title">
      <div className="hero-words">
        <h1 id="home-title" className="display hero-title m-0">
          {copy.home.title.before}
          <b>{copy.home.title.strong}</b>
          {copy.home.title.after}
        </h1>
        <div key={`record-${market}`} className={`hero-record${enter}`}>
          <p className="hero-label">
            <a href={`#label-${slug(label.name)}`}>{label.name}</a>
            {marketName !== null ? <span>{marketName}</span> : null}
          </p>
          <p className="hero-rec">
            <b>{record.artist}</b>
            <i>{record.title}</i>
          </p>
          <p className="hero-meta">{copy.catalogue.tracks(record.tracks, runningTime(record.minutes))}</p>
          <p className="hero-note">{record.note}</p>
        </div>
        <section className="feature" aria-labelledby="feature-title">
          <span className="feature-art">
            <Sleeves records={session.records.map((each) => ({ ...each, label: label.name }))} className="block h-auto w-full" />
          </span>
          <div className="feature-words">
            <h2 id="feature-title" className="feature-title">{copy.home.sessionTitle(label.name)}</h2>
            <p>
              {session.records.map((each, index) => (
                <span key={each.id}>
                  {index > 0 ? "; " : null}
                  {each.artist}, <i>{each.title}</i>
                </span>
              ))}
            </p>
            <p className="num">
              {copy.catalogue.sessionFacts(session.records.length, session.tracks)}, {runningTime(session.minutes)}
            </p>
          </div>
          <Link className="btn btn-primary btn-big feature-go" href={sessionHref(label)}>
            <Icon name="play" size={18} />
            {copy.home.listen}
          </Link>
        </section>
      </div>
      <figure key={`cover-${market}`} className={`hero-cover${enter}`}>
        <Cover record={{ ...record, label: label.name }} className="cover-hero" />
        <figcaption>{copy.home.coverNote(capital(technique), label.name)}</figcaption>
      </figure>
    </section>
  );
}
