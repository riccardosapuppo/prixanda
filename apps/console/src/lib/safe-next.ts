// Where the entry sends someone once they chose who they are: back to the
// page that sent them there, named by the address's next. Only a path of the
// console, whatever the address holds. A browser reads a backslash in a web
// address as a slash and drops tabs and line breaks from it, so "/\example.com"
// and "/<tab>/example.com" both mean //example.com, another site: such an
// address is refused before it is read. What is left is read as a web
// address against a fixed origin, and kept only if it stays there, as its
// path, query and fragment, written the way the browser writes them.

/** The origin a next is read against: one that no path can reach anywhere else from. */
const BASE = "https://console.invalid";

/** A backslash, or a control character: C0, DEL and C1. */
const REFUSED = /[\\\u0000-\u001f\u007f-\u009f]/;

/** Only a path inside the console: the entry never sends anyone elsewhere, nor back to itself. */
export function safeNext(next: string | null): string {
  if (next === null || !next.startsWith("/") || next.startsWith("//") || REFUSED.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE || url.pathname.startsWith("/sign-in")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
