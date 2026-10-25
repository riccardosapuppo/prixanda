// The catalog's artists in the console's schema (stage 7, §14.2): a campaign
// for an album release aims at the fans of one of them, and the console finds
// the artist by a part of their name, or names the one a saved version aims
// at by its id. Marketing, the commercial lead and finance read them; the
// gateway says what it refuses before the engine hears anything, and passes
// on what the engine refuses. The fake engine follows the engine's
// ListArtists (commerce/engine/catalog.py).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { codes, type Harness, startHarness } from "./support/harness.ts";

const PAGE = "nodes { id name label country latestRelease { title releasedOn } } next";

let harness: Harness;
before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

describe("the artists", () => {
  test("by name, with their label, country and latest record; a part of the name in any case; the ids a version names", async () => {
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    harness.engine.clearCalls();
    const found = await marketing.graphql(`{ artists(search: "  DOPPEL ") { ${PAGE} } }`);
    assert.equal(found.body.errors, undefined, found.text);
    assert.deepEqual(found.body.data.artists, {
      nodes: [{ id: 4, name: "Doppelfenster", label: "Kellerlicht", country: "DE", latestRelease: { title: "Nordflur", releasedOn: "2026-11-06" } }],
      next: null,
    });
    const call = harness.engine.calls.find((candidate) => candidate.method === "ListArtists");
    assert.deepEqual([call?.actor, call?.role, call?.idempotencyKey], ["marketing-1", "marketing", null]);
    const sent = call?.message as { search: string; ids: number[]; page?: { size: number; after: string } } | undefined;
    assert.deepEqual([sent?.search, sent?.ids, sent?.page?.size, sent?.page?.after], ["DOPPEL", [], 20, ""], "trimmed, no ids, the first page of 20");
    // An artist without a record has none; the saved version's artist, by id.
    const named = await marketing.graphql("{ artists(ids: [7, 4]) { nodes { name latestRelease { title } } } }");
    assert.deepEqual(named.body.data.artists.nodes, [{ name: "Doppelfenster", latestRelease: { title: "Nordflur" } }, { name: "Halde", latestRelease: null }]);
  });

  test("a page at a time, the engine's cursor carried as it came", async () => {
    const lead = harness.console();
    await lead.signIn("commercial-lead-1");
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { body: { data: { artists: { nodes: { name: string }[]; next: string | null } } } } =
        await lead.graphql("query ($after: String) { artists(first: 3, after: $after) { nodes { name } next } }", { variables: { after: cursor } });
      names.push(...page.body.data.artists.nodes.map((artist) => artist.name));
      cursor = page.body.data.artists.next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(names, ["Ciel Fendu", "Corale Ferrovia", "Doppelfenster", "Halde", "Ottoline Marr", "Pinewire", "Velluto Basso"]);
  });

  test("finance reads them too; the roles that neither write nor sign an offer are FORBIDDEN, and the engine hears nothing", async () => {
    const finance = harness.console();
    await finance.signIn("finance-1");
    assert.equal((await finance.graphql("{ artists { nodes { id } } }")).body.data.artists.nodes.length, 7);
    for (const person of ["catalog-manager-1", "on-call-1", "auditor-1"]) {
      const reader = harness.console();
      await reader.signIn(person);
      harness.engine.clearCalls();
      assert.deepEqual(codes(await reader.graphql("{ artists { nodes { id } } }")), ["FORBIDDEN"], person);
      assert.equal(harness.engine.count("ListArtists"), 0, person);
    }
  });

  test("a search too long, too many ids, an id that is no id, a page out of range: BAD_USER_INPUT before the engine", async () => {
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    harness.engine.clearCalls();
    const refused = [
      `{ artists(search: "${"x".repeat(81)}") { nodes { id } } }`,
      `{ artists(ids: [${Array.from({ length: 101 }, (_, n) => n + 1).join(", ")}]) { nodes { id } } }`,
      "{ artists(ids: [0]) { nodes { id } } }",
      "query ($first: Int!) { artists(first: $first) { nodes { id } } }",
      `{ artists(after: "${"c".repeat(201)}") { nodes { id } } }`,
    ];
    for (const query of refused) {
      assert.deepEqual(codes(await marketing.graphql(query, { variables: { first: 101 } })), ["BAD_USER_INPUT"], query.slice(0, 60));
    }
    // A page size written in the document is the validation's, as on every paged field (limits.ts).
    assert.deepEqual(codes(await marketing.graphql("{ artists(first: 0) { nodes { id } } }")), ["GRAPHQL_VALIDATION_FAILED"]);
    assert.equal(harness.engine.count("ListArtists"), 0);
  });

  test("a cursor the engine did not give is the engine's BAD_USER_INPUT, with its words", async () => {
    const marketing = harness.console();
    await marketing.signIn("marketing-1");
    const answer = await marketing.graphql('{ artists(after: "not-a-cursor") { nodes { id } } }');
    assert.deepEqual(codes(answer), ["BAD_USER_INPUT"]);
    assert.match(answer.text, /not a cursor this engine gave/);
  });
});
