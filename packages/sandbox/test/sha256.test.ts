// The SHA-256 the sandbox gives Apollo Server in place of sha.js: the same
// digests as Node's own, on the lengths around a block's edges and on text
// beyond ASCII, through update() in one piece or several.
import assert from "node:assert/strict";
import { createHash as nodeHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, test } from "node:test";

const createHash = createRequire(import.meta.url)("../src/gateway/sha256.cjs") as (kind: string) => {
  update(data: string | Uint8Array): { update(data: string | Uint8Array): unknown; digest(encoding: "hex"): string };
  digest(encoding: "hex"): string;
};

describe("the sandbox's SHA-256", () => {
  test("gives Node's digests, at every length around the 64-byte block and its padding", () => {
    for (let length = 0; length <= 200; length += 1) {
      const text = "q".repeat(length);
      assert.equal(createHash("sha256").update(text).digest("hex"), nodeHash("sha256").update(text).digest("hex"), `${length} bytes`);
    }
  });

  test("hashes text as UTF-8, and pieces as one", () => {
    const query = 'query { offers(market: "DE") { title } } # Größe, prix, €, 音楽';
    const expected = nodeHash("sha256").update(query).digest("hex");
    assert.equal(createHash("sha256").update(query).digest("hex"), expected);
    const hash = createHash("sha256");
    hash.update(query.slice(0, 10));
    hash.update(new TextEncoder().encode(query.slice(10)));
    assert.equal(hash.digest("hex"), expected);
  });

  test("hashes nothing but SHA-256", () => {
    assert.throws(() => createHash("sha512"), /only sha256/);
  });
});
