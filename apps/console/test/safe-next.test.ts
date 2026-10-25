// Where the entry sends someone once they chose who they are (src/lib/safe-next.ts):
// back to a page of the console, never elsewhere. A browser reads a backslash
// in a web address as a slash and drops tabs and line breaks from it, so
// "/\example.com" or "/<tab>/example.com" would leave for another site;
// every such address, and every one that is not a path, sends to the home.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeNext } from "../src/lib/safe-next.ts";

/** The next of an address, as the page reads it: decoded. */
const nextOf = (query: string) => new URLSearchParams(query).get("next");

describe("the entry's next", () => {
  it("keeps a path of the console, with its query and its fragment", () => {
    assert.equal(safeNext("/campaigns/?id=3#x"), "/campaigns/?id=3#x");
    assert.equal(safeNext("/audit/?change=12&action=change.created"), "/audit/?change=12&action=change.created");
    assert.equal(safeNext(nextOf("next=%2Flaunches%2Frun%2F%3Fid%3D7")), "/launches/run/?id=7");
    assert.equal(safeNext("/"), "/");
  });

  it("writes the path the way the address reads it: dots resolved, spaces encoded", () => {
    assert.equal(safeNext("/campaigns/../audit/"), "/audit/");
    assert.equal(safeNext("/campaigns/?q=two words"), "/campaigns/?q=two%20words");
  });

  it("refuses a backslash, which the browser reads as a slash, decoded or written", () => {
    assert.equal(safeNext("/\\example.com"), "/");
    assert.equal(safeNext("/\\/example.com"), "/");
    assert.equal(safeNext("\\\\example.com"), "/");
    assert.equal(safeNext(nextOf("next=%2F%5Cexample.com")), "/");
    assert.equal(safeNext("/campaigns/\\x"), "/");
  });

  it("refuses tabs, line breaks and other control characters, which the browser drops", () => {
    assert.equal(safeNext("/\t/example.com"), "/");
    assert.equal(safeNext("/\texample.com"), "/");
    assert.equal(safeNext("/\n/example.com"), "/");
    assert.equal(safeNext("/\r\n/example.com"), "/");
    assert.equal(safeNext(nextOf("next=%2F%09%2Fexample.com")), "/");
    assert.equal(safeNext("/campaigns/\u0000"), "/");
    assert.equal(safeNext("/campaigns/\u007f"), "/");
  });

  it("refuses what is not a path: another host, another scheme, nothing at all", () => {
    assert.equal(safeNext("//example.com"), "/");
    assert.equal(safeNext("//example.com/campaigns/"), "/");
    assert.equal(safeNext("https://example.com"), "/");
    assert.equal(safeNext("javascript:alert(1)"), "/");
    assert.equal(safeNext("campaigns/"), "/");
    assert.equal(safeNext(""), "/");
    assert.equal(safeNext(null), "/");
  });

  it("refuses a path that its dots turn into another host", () => {
    // "/./" and "/a/../" are resolved away, and what is left starts with two slashes: another site.
    assert.equal(safeNext("/.//example.com"), "/");
    assert.equal(safeNext("/a/..//example.com"), "/");
    assert.equal(safeNext("/a/%2e%2e//example.com"), "/");
    assert.equal(safeNext(nextOf("next=%2F.%2F%2Fexample.com")), "/");
  });

  it("keeps an encoded backslash as part of a path: it stays on the console", () => {
    assert.equal(safeNext("/%5Cexample.com"), "/%5Cexample.com");
  });

  it("never sends back to the entry itself", () => {
    assert.equal(safeNext("/sign-in/"), "/");
    assert.equal(safeNext("/sign-in/?next=%2Fcampaigns%2F"), "/");
    assert.equal(safeNext("/campaigns/../sign-in/"), "/");
  });
});
