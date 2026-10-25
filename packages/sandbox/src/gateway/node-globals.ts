// Node's globals, in the worker's bundle, as much of them as the bundled
// libraries read in a browser; scripts/build.ts injects them where the code
// names them.
//   - process: an empty environment. Apollo Server reads its APOLLO_ settings
//     from process.env when it is built, and finds none, so it reports to no
//     one; the libraries that look for Node (process.versions,
//     process.nextTick) do not find it, and take their browser's path.
//   - Buffer: nothing in a browser is one. Apollo Server asks
//     Buffer.isBuffer(body) of every request's body (runHttpQuery).
export const process: { readonly env: Readonly<Record<string, string | undefined>> } = { env: {} };

export const Buffer = { isBuffer: (_value: unknown): boolean => false } as const;
