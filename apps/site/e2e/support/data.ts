// The generated data of the site's end-to-end tests: the small size, seed 7,
// until DATA_UNTIL. The engine of these tests runs on a clock the test moves,
// and every test starts it on that day, so the data and the clock never part:
// the engine loads data that ends the day before, as a real engine does on the
// morning after its data's last day. Started on another day, it would meet
// listeners who joined after it, or listening that has not happened yet. The
// stack (stack.ts) and npm run check (tools/check.ts) fill their databases
// with these arguments.
export const DATA_UNTIL = "2026-10-24";

export const GENERATOR_ARGS = ["--size", "small", "--seed", "7", "--until", DATA_UNTIL] as const;
