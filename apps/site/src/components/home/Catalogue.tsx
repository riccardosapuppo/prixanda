"use client";
// The service's music on its home: the labels' new records, each with its
// cover printed in its label's technique, and the listening sessions, one
// per label, as a programme. The catalogue is the service's editorial
// content (src/content/editorial.ts), read through the data layer.
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { copy } from "../../content/copy.ts";
import { type Label, releasesOf, runningTime, sessionOf, slug } from "../../content/editorial.ts";
import { useLabels, useMarkets, useReleases } from "../../data/hooks.ts";
import { Cover, Sleeves } from "../art/Cover.tsx";
import { TECHNIQUE } from "../art/covers.ts";

function useMarketName() {
  const markets = useMarkets();
  return (code: string) => markets.data?.find((each) => each.code === code)?.name ?? code;
}

export function Releases() {
  const labels = useLabels();
  const releases = useReleases();
  const marketName = useMarketName();
  return (
    <section className="section wrap" id="releases" aria-labelledby="releases-title">
      <div className="section-head">
        <h2 className="title-2 m-0" id="releases-title">{copy.catalogue.releases}</h2>
      </div>
      <div className="labels-grid">
        {labels.data.map((label) => {
          const records = releasesOf(label, releases.data);
          const id = `label-${slug(label.name)}`;
          return (
            <article key={label.id} className="label-block" id={id} aria-labelledby={`${id}-name`}>
              <header className="label-head">
                <h3 id={`${id}-name`}>{label.name}</h3>
                <p>{copy.catalogue.labelFacts(marketName(label.country), records.length, TECHNIQUE[label.name] ?? "linocut")}</p>
              </header>
              <ul role="list" className={records.length === 1 ? "records records-one" : "records"}>
                {records.map((record) => (
                  <li key={record.id} className="record">
                    <Cover record={{ ...record, label: label.name }} className="cover" />
                    <p className="record-who">
                      {record.artist}
                      <span className="record-title">{record.title}</span>
                    </p>
                    <p className="record-meta">{copy.catalogue.tracks(record.tracks, runningTime(record.minutes))}</p>
                    <p className="record-note">{record.note}</p>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function sessionHref(label: Label): Route {
  return `/session/?label=${slug(label.name)}` as Route;
}

export function Sessions() {
  const labels = useLabels();
  const releases = useReleases();
  const marketName = useMarketName();
  return (
    <section className="section wrap" id="sessions" aria-labelledby="sessions-title">
      <div className="section-head">
        <h2 className="title-2 m-0" id="sessions-title">{copy.catalogue.sessions}</h2>
      </div>
      <ol role="list" className="programme">
        {labels.data.map((label) => {
          const session = sessionOf(label, releases.data);
          return (
            <li key={label.id} className="session">
              <span className="session-art">
                <Sleeves records={session.records.map((record) => ({ ...record, label: label.name }))} className="block h-auto w-full" />
              </span>
              <div className="session-words">
                <h3>
                  {label.name}
                  <span>{marketName(label.country)}</span>
                </h3>
                <p>
                  {session.records.map((record, index) => (
                    <span key={record.id}>
                      {index > 0 ? "; " : null}
                      {record.artist}, <i>{record.title}</i>
                    </span>
                  ))}
                </p>
              </div>
              <p className="session-facts">
                {copy.catalogue.sessionFacts(session.records.length, session.tracks)}
                <b>{runningTime(session.minutes)}</b>
              </p>
              <Link className="btn" href={sessionHref(label)}>
                <Icon name="play" size={16} />
                {copy.catalogue.listen}
                <span className="sr-only">{copy.catalogue.listenTo(label.name)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
