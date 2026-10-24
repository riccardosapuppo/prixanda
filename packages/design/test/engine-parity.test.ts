// The console writes money exactly as the engine does: the same amounts go
// through this package and through the engine's own format_money,
// format_count and format_percent (services/commerce), and the two answers
// must be the same, character for character.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatCount, formatMoney, formatPercent } from "../src/money.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const windows = process.platform === "win32";
const python = join(repoRoot, ".venv", windows ? "Scripts" : "bin", windows ? "python.exe" : "python");

/** A deterministic spread of amounts: small, around the separators, large, and each one negative too. */
function amounts(): bigint[] {
  const found = new Set<bigint>([0n, 1n, 5n, 99n, 100n, 101n, 999n, 1000n, 99999n, 100000n, 187751n, 200971416n, 10n ** 15n]);
  let state = 20261024n;
  for (let i = 0; i < 300; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    found.add(state % 10n ** BigInt(1 + (i % 13)));
  }
  return [...found].flatMap((amount) => [amount, -amount]);
}

const SCRIPT = [
  "import json, sys",
  "from commerce.domain.money import Money, format_money, format_count, format_percent",
  "data = json.load(sys.stdin)",
  "out = {",
  "  'money': [format_money(Money(int(a), c)) for a, c in data['money']],",
  "  'count': [format_count(int(n)) for n in data['count']],",
  "  'percent': [format_percent(int(b)) for b in data['percent']],",
  "}",
  "sys.stdout.write(json.dumps(out, ensure_ascii=False))",
].join("\n");

describe("the engine and this package write the same amounts the same way", () => {
  it("money in EUR, GBP and JPY, counts and percentages", () => {
    assert.ok(existsSync(python), `the engine's Python is missing at ${python}: npm run setup`);
    const cases = amounts();
    const shares = [0, 1, 25, 50, 99, 100, 1200, 1250, 4000, 6555, 10000, 12345, -150];
    const money = cases.flatMap((amount) => ["EUR", "GBP", "JPY"].map((currency) => [amount.toString(), currency] as const));
    const counts = cases.filter((amount) => amount >= 0n).map((amount) => amount.toString());
    const ran = spawnSync(python, ["-X", "utf8", "-c", SCRIPT], {
      input: JSON.stringify({ money, count: counts, percent: shares }),
      env: { ...process.env, PYTHONPATH: join(repoRoot, "services", "commerce", "src"), PYTHONIOENCODING: "utf-8" },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(ran.status, 0, ran.stderr);
    const engine = JSON.parse(ran.stdout) as { money: string[]; count: string[]; percent: string[] };
    assert.equal(engine.money.length, money.length);
    money.forEach(([amountMinor, currency], index) => {
      assert.equal(formatMoney({ amountMinor, currency }), engine.money[index], `${amountMinor} ${currency}`);
    });
    counts.forEach((count, index) => assert.equal(formatCount(BigInt(count)), engine.count[index], count));
    shares.forEach((share, index) => assert.equal(formatPercent(share), engine.percent[index], String(share)));
    assert.ok(money.length > 1500, `only ${money.length} amounts compared`);
  });
});
