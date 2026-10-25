// The demo's clock: the time of the story, not the machine's. The build
// writes in the snapshot the moment the story starts (the morning after the
// data ends, build/snapshot.ts), and every visitor starts there, on whatever
// day they come: the data's weeks of listening, the campaigns' dates and the
// launches scheduled stay where the story puts them. From there the clock runs
// at the machine's pace while the demo is open, and jumps forward when the
// demo asks (advanceTo, the skip to the next launch); it stands still while
// no tab is open. A reset goes back to the start of the story, with the rest
// of the snapshot.
//
// It goes forward only: an instant not after the demo's now leaves it where it
// is, so that nextDue() can name a moment just passed without an error. Each
// jump is saved in the database (demo.clock, database.ts), in order, and at a
// start the clock is never behind the audit log's latest event, so that the
// time of a write is never in the future of a later visit.
export class DemoClock {
  #startMs: number;
  #startedAt: number;
  #saving: Promise<void> = Promise.resolve();
  readonly #save: (instantMs: number) => Promise<void>;

  /** The clock at startMs now; save keeps each jump. */
  constructor(startMs: number, save: (instantMs: number) => Promise<void>) {
    this.#startMs = startMs;
    this.#startedAt = performance.now();
    this.#save = save;
  }

  nowMs(): number {
    return this.#startMs + Math.round(performance.now() - this.#startedAt);
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  advanceTo(instant: Date): void {
    const target = instant.getTime();
    if (!Number.isFinite(target)) throw new RangeError("advanceTo takes an instant");
    if (target <= this.nowMs()) return;
    this.#startMs = target;
    this.#startedAt = performance.now();
    this.#saving = this.#saving.then(() => this.#save(target)).catch((error: unknown) => {
      console.warn(`the demo's clock moved, and could not be saved: ${String(error)}`);
    });
  }

  /** Settles when every jump so far is saved. */
  saved(): Promise<void> {
    return this.#saving;
  }
}
