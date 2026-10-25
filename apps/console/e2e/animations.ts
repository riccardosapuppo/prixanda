// What a check of the page waits for before it measures: the animations under
// way that have an end. A confirmation, or any part that comes in fading, is
// half transparent until its animation ends, and axe would measure its colours
// then: a slow machine reaches axe sooner, in the animation's own time. An
// animation without an end, a loading shape that pulses as long as something
// loads, is not waited for.
import type { Page } from "playwright";

/** Waits until the page's animations that have an end have ended, at most `limit` milliseconds. */
export async function animationsEnded(page: Page, limit = 10_000): Promise<void> {
  await page.evaluate(async (limit) => {
    const deadline = performance.now() + limit;
    // An animation that ends can start another (a part that comes in after the one before it): a few rounds.
    for (let round = 0; round < 5; round++) {
      const ending = document.getAnimations().filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
      });
      const left = deadline - performance.now();
      if (ending.length === 0 || left <= 0) return;
      await Promise.race([
        Promise.allSettled(ending.map((animation) => animation.finished)),
        new Promise((resolve) => setTimeout(resolve, left)),
      ]);
    }
  }, limit);
}
