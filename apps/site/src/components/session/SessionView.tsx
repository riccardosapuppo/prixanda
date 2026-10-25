"use client";
// A listening session, simulated: a label's records one after the other,
// with the running order, the lengths and how far the session has got.
// Nothing plays (business book §15: music and audio are not part of the
// product): play moves a clock one second a second, and the page says so
// next to the button. A record's time is split evenly among its tracks
// (src/lib/session.ts), and the tracks have no titles, since none were
// written. Nothing here moves: the clock, the buttons and the running order
// change in place, the way a player's do.
import { Icon } from "design/icon";
import type { Route } from "next";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type CSSProperties, useEffect, useState } from "react";
import { copy } from "../../content/copy.ts";
import { type Label, type Release, runningTime, sessionOf, slug } from "../../content/editorial.ts";
import { useLabels, useMarketName, useReleases } from "../../data/hooks.ts";
import { Named } from "../ui/States.tsx";
import { clock, nextStart, positionAt, previousStart, timeline } from "../../lib/session.ts";
import { Cover } from "../art/Cover.tsx";
import { TECHNIQUE } from "../art/covers.ts";

const BACK = "/#sessions" as Route;

export function SessionView() {
  const search = useSearchParams();
  const labels = useLabels();
  const asked = search.get("label");
  const label = labels.data.find((each) => slug(each.name) === asked);

  useEffect(() => {
    if (label !== undefined) document.title = `${copy.session.title(label.name)} · ${copy.service}`;
  }, [label]);

  if (label === undefined) {
    return (
      <div className="wrap grid max-w-[44rem] justify-items-start gap-4 pt-[clamp(1.75rem,3vw,3rem)] pb-16">
        <h1 className="title-2 m-0">{copy.session.missing.title}</h1>
        <p className="m-0 max-w-[60ch] text-ink-2">{copy.session.missing.body}</p>
        <Link className="btn" href={BACK}>
          <Icon name="arrow-left" size={16} />
          {copy.session.missing.action}
        </Link>
      </div>
    );
  }
  return <Session key={label.id} label={label} />;
}

function Session({ label }: { readonly label: Label }) {
  const releases = useReleases();
  const marketNameOf = useMarketName();
  const session = sessionOf(label, releases.data);
  const records = session.records;
  const line = timeline(records);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);

  // One second a second while playing; the clock stops at the end of the session.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setAt((was) => Math.min(line.total, was + 1)), 1000);
    return () => window.clearInterval(timer);
  }, [playing, line.total]);
  useEffect(() => {
    if (playing && at >= line.total) setPlaying(false);
  }, [playing, at, line.total]);

  const where = positionAt(records, line, at);
  const now = records[where.index];
  if (now === undefined) return null;
  const marketName = marketNameOf(label.country);
  const technique = TECHNIQUE[label.name] ?? "linocut";
  const started = playing || at > 0;
  const playWords = playing ? copy.session.pause : at > 0 && at < line.total ? copy.session.playOn : copy.session.play;

  const play = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (at >= line.total) setAt(0);
    setPlaying(true);
  };
  const previous = () => setAt(previousStart(line, where));
  const next = () => {
    const to = nextStart(line, where);
    setAt(to);
    if (to >= line.total) setPlaying(false);
  };

  return (
    <div className="listen wrap">
      <div className="listen-art">
        <figure>
          <Cover record={{ ...now, label: label.name }} className="cover-listen" />
          <figcaption>{now.note}</figcaption>
        </figure>
      </div>
      <div className="listen-main">
        <p className="listen-back">
          <Link href={BACK}>
            <Icon name="arrow-left" size={16} />
            {copy.session.back}
          </Link>
        </p>
        <h1 className="display listen-title m-0">{copy.session.title(label.name)}</h1>
        <p className="listen-facts">
          <Named ready={marketName !== null}>
            {copy.session.facts(marketName ?? label.country, records.length, session.tracks, runningTime(session.minutes), technique)}
          </Named>
        </p>
        <section className="player" id="player" aria-labelledby="player-title">
          <h2 className="sr-only" id="player-title">{copy.session.player}</h2>
          <p className="player-now" aria-live="polite">
            <Icon name={playing ? "pause" : "play"} size={16} />
            <span>
              <b>{now.artist}</b>, <i>{now.title}</i>. {copy.session.now(where.track, now.tracks)}
            </span>
          </p>
          <div className="player-groove">
            <label className="sr-only" htmlFor="session-position">{copy.session.position}</label>
            <input
              id="session-position"
              type="range"
              min={0}
              max={line.total}
              step={1}
              value={at}
              onChange={(event) => setAt(Number(event.currentTarget.value))}
              aria-valuetext={`${clock(at)} of ${clock(line.total)}. ${now.artist}, ${now.title}: track ${where.track} of ${now.tracks}`}
              style={{ "--done": `${((at / line.total) * 100).toFixed(3)}%` } as CSSProperties}
            />
            <span className="player-marks" aria-hidden="true">
              {line.starts.slice(1).map((start) => <i key={start} style={{ left: `${((start / line.total) * 100).toFixed(2)}%` }} />)}
            </span>
          </div>
          <p className="player-times">
            <span>{clock(at)}</span>
            <span>{clock(line.total)}</span>
          </p>
          <div className="player-controls">
            <button type="button" className="btn" onClick={previous}>
              <Icon name="skip-forward" size={18} className="flip-x" />
              {copy.session.previous}
            </button>
            <button type="button" className="btn btn-primary btn-big" onClick={play} aria-describedby="session-simulated">
              <Icon name={playing ? "pause" : "play"} size={20} />
              {playWords}
            </button>
            <button type="button" className="btn" onClick={next}>
              {copy.session.next}
              <Icon name="skip-forward" size={18} />
            </button>
          </div>
          <p className="player-sim" id="session-simulated">
            <Icon name="flask" size={15} />
            <span>{copy.session.simulated}</span>
          </p>
        </section>
        <section className="running" aria-labelledby="running-title">
          <h2 className="running-title" id="running-title">{copy.session.running}</h2>
          <ol role="list" className="running-list">
            {records.map((record, index) => (
              <RunItem
                key={record.id}
                record={record}
                label={label.name}
                start={line.starts[index] ?? 0}
                kind={index < where.index ? "played" : index === where.index ? "now" : "next"}
                started={started}
                playing={playing}
              />
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function RunItem({ record, label, start, kind, started, playing }: {
  readonly record: Release;
  readonly label: string;
  readonly start: number;
  readonly kind: "played" | "now" | "next";
  readonly started: boolean;
  readonly playing: boolean;
}) {
  return (
    <li className={`run-item is-${kind}`} {...(kind === "now" ? { "aria-current": "true" as const } : {})}>
      <Cover record={{ ...record, label }} className="cover" words={false} decorative />
      <span className="run-item-words">
        <b>{record.artist}</b>
        <i>{record.title}</i>
        <small>{copy.session.from(record.tracks, runningTime(record.minutes), clock(start))}</small>
      </span>
      {kind === "now" && started ? (
        <span className="state state-live">
          <Icon name={playing ? "play" : "pause"} size={13} />
          {playing ? copy.session.playing : copy.session.paused}
        </span>
      ) : null}
      {kind === "now" && !started ? <span className="state state-first">{copy.session.first}</span> : null}
      {kind === "played" ? (
        <span className="state state-done">
          <Icon name="check" size={13} />
          {copy.session.played}
        </span>
      ) : null}
    </li>
  );
}
