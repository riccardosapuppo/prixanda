// The demo's clock: the machine's time plus an offset the demo moved it by,
// so that a visitor need not wait for a campaign's start ("skip to the next
// launch"). It goes forward only: an instant not after the demo's now leaves
// it where it is, so that nextDue() can name a moment just passed without an
// error. The offset is saved in the database (demo.clock, database.ts), in
// order, and at the start the clock is never behind the latest event of the
// audit log, so that a saving lost in a closing tab never sends it back.
export class DemoClock {
  #offsetMs: number;
  #saving: Promise<void> = Promise.resolve();
  readonly #save: (offsetMs: number) => Promise<void>;

  constructor(offsetMs: number, save: (offsetMs: number) => Promise<void>) {
    this.#offsetMs = offsetMs;
    this.#save = save;
  }

  nowMs(): number {
    return Date.now() + this.#offsetMs;
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  get offsetMs(): number {
    return this.#offsetMs;
  }

  advanceTo(instant: Date): void {
    const target = instant.getTime();
    if (!Number.isFinite(target)) throw new RangeError("advanceTo takes an instant");
    if (target <= this.nowMs()) return;
    this.#offsetMs = target - Date.now();
    const offset = this.#offsetMs;
    this.#saving = this.#saving.then(() => this.#save(offset)).catch((error: unknown) => {
      console.warn(`the demo's clock moved, and could not be saved: ${String(error)}`);
    });
  }

  /** Settles when every move so far is saved. */
  saved(): Promise<void> {
    return this.#saving;
  }
}
