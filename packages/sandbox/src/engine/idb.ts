// Where the browser keeps the demo's database: IndexedDB, under the name
// Emscripten's IDBFS gives PGlite's data directory, /pglite/<name>, one entry
// per file, keyed by its path. The engine asks it whether the data is there
// before opening it (a first visit loads the build's snapshot instead), and
// deletes it for a reset.
//
// IDBFS creates its database as soon as PGlite mounts it, before anything is
// saved: a tab closed during a first visit can leave one that holds no
// cluster. So the data is there only when the cluster's PG_VERSION is; an
// empty database is deleted, and the visit is a first one again.

/** The name IndexedDB holds a PGlite database under: Emscripten's IDBFS names it after its mount point, /pglite/<name>. */
export function indexedDbName(dataDir: string): string {
  if (!dataDir.startsWith("idb://")) throw new Error(`not a database of IndexedDB: ${dataDir}`);
  return `/pglite/${dataDir.slice("idb://".length)}`;
}

const STORE = "FILE_DATA"; // IDBFS's object store

function opened(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB did not open ${name}`));
  });
}

async function holdsCluster(name: string): Promise<boolean> {
  const db = await opened(name);
  try {
    if (!db.objectStoreNames.contains(STORE)) return false;
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).count(`${name}/PG_VERSION`);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB did not read ${name}`));
    });
  } finally {
    db.close();
  }
}

export async function existsInIndexedDb(dataDir: string): Promise<boolean> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    throw new Error("this browser cannot list its IndexedDB databases, which the demo needs to find its data");
  }
  const name = indexedDbName(dataDir);
  if (!(await indexedDB.databases()).some((database) => database.name === name)) return false;
  if (await holdsCluster(name)) return true;
  await deleteFromIndexedDb(dataDir);
  return false;
}

export async function deleteFromIndexedDb(dataDir: string): Promise<void> {
  const name = indexedDbName(dataDir);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB did not delete ${name}`));
  });
}
