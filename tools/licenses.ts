// The licences of everything the repository runs, builds with or ships,
// against the project's policy ("Software licences" in
// docs/legal-and-licensing.md).
//
//   npm run licenses    prints the count by licence and writes reports/licenses.json
//
// Four inventories. npm's lockfile records each package's licence. The
// engine's Python environment is read with importlib.metadata. The files
// `npm run setup` downloads (Flyway's jars and the Java runtime, in
// tools/flyway-lock.json) carry no machine-readable licence, so theirs are
// written below, from what each jar or its parent POM declares. And the
// sandbox serves two Python wheels and the standard library inside Pyodide.
//
// A package passes when its licence expression holds only licences the policy
// accepts. The few that do not are exceptions named one by one, each with the
// reason it never reaches what the project distributes. A licence nobody has
// looked at fails the check.
//
// It also writes the notices the demo carries (THIRD-PARTY-NOTICES.txt, at
// the root of dist/demo, and in reports/): see demoNotices below.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedWheels, pyodideDir, wheelsHome } from "../packages/sandbox/src/engine/build/wheels.ts";
import { repoRoot, venvPython } from "./lib/paths.ts";
import { run } from "./lib/run.ts";

export type Entry = {
  readonly source: "npm" | "python" | "setup";
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Whether only development and the build use it (npm's dev flag; the setup's downloads; the engine's test tools). */
  readonly devOnly: boolean;
  /** "allowed", or the reason an exception lets it through. */
  readonly verdict: string;
};

// Permissive licences: allowed wherever the package ends up, with the notice kept.
const PERMISSIVE = new Set([
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "Python-2.0", "PSF-2.0",
  "Unlicense", "CC0-1.0", "Zlib", "PostgreSQL", "OFL-1.1",
]);
// File-level copyleft: allowed for files used as they are, whose source stays
// where npm or PyPI publishes it. Nothing in the repository modifies them.
const UNMODIFIED = new Set(["MPL-2.0"]);

const EXCEPTIONS: readonly { readonly match: RegExp; readonly license: RegExp; readonly reason: string }[] = [
  {
    match: /^@img\/sharp-/,
    license: /LGPL-3\.0-or-later/,
    reason:
      "libvips, installed by Next.js for its image optimizer, which runs only on a server; both apps are static exports with unoptimized images, so none of it is built or shipped",
  },
  {
    match: /^caniuse-lite$/,
    license: /^CC-BY-4\.0$/,
    reason: "browser support data read by the build tools, never shipped; attribution: Alexis Deveria, caniuse.com",
  },
  {
    match: /^Eclipse Temurin JRE$/,
    license: /^GPL-2\.0-only WITH Classpath-exception-2\.0$/,
    reason: "the Java runtime Flyway runs on, downloaded by setup into .tools and started as a separate program; never shipped",
  },
];

// Python's trove classifiers, in SPDX words.
const CLASSIFIERS: Record<string, string> = {
  "MIT License": "MIT",
  "Apache Software License": "Apache-2.0",
  "3-Clause BSD License": "BSD-3-Clause",
  "BSD License": "BSD-3-Clause",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "Python Software Foundation License": "PSF-2.0",
};

// What Flyway's jars declare: flyway-parent 13.10.0's POM (Apache-2.0, for
// every flyway-* module), the jars' own LICENSE files and manifests otherwise.
const JARS: readonly [RegExp, string][] = [
  [/^flyway-/, "Apache-2.0"],
  [/^(annotations|commons-lang3|commons-text|jackson-[a-z-]+|woodstox-core)-/, "Apache-2.0"],
  [/^jansi-/, "BSD-3-Clause"],
  [/^(lombok|slf4j-api|slf4j-nop)-/, "MIT"],
  [/^(postgresql|stax2-api)-/, "BSD-2-Clause"],
];

/** Every licence an SPDX expression needs, as alternatives: "A OR (B AND C)" is [[A], [B, C]]. */
function alternatives(expression: string): string[][] {
  const tokens = expression.replace(/[()]/g, " $& ").split(/\s+/).filter(Boolean);
  let at = 0;
  const parseOr = (): string[][] => {
    let left = parseAnd();
    while (tokens[at] === "OR") {
      at += 1;
      left = [...left, ...parseAnd()];
    }
    return left;
  };
  const parseAnd = (): string[][] => {
    let left = parseAtom();
    while (tokens[at] === "AND") {
      at += 1;
      const right = parseAtom();
      left = left.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return left;
  };
  const parseAtom = (): string[][] => {
    if (tokens[at] === "(") {
      at += 1;
      const inner = parseOr();
      at += 1;
      return inner;
    }
    let id = tokens[at++] ?? "";
    if (tokens[at] === "WITH") {
      id += ` WITH ${tokens[at + 1] ?? ""}`;
      at += 2;
    }
    return [[id]];
  };
  return parseOr();
}

function judge(name: string, license: string): string {
  const fits = alternatives(license).some((needed) => needed.every((id) => PERMISSIVE.has(id) || UNMODIFIED.has(id)));
  if (fits) return "allowed";
  const exception = EXCEPTIONS.find((rule) => rule.match.test(name) && rule.license.test(license));
  return exception ? `exception: ${exception.reason}` : "";
}

function npmEntries(): Entry[] {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; license?: string; dev?: boolean; link?: boolean }>;
  };
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path.includes("node_modules/") && !entry.link)
    .map(([path, entry]) => {
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const license = entry.license ?? "(none declared)";
      return { source: "npm", name, version: entry.version ?? "?", license, devOnly: entry.dev === true, verdict: judge(name, license) };
    });
}

const PYTHON_DEV = new Set(["grpcio-tools", "hypothesis", "iniconfig", "pluggy", "pygments", "pytest", "pytest-asyncio", "sortedcontainers", "colorama", "pip", "setuptools", "packaging"]);

async function pythonEntries(): Promise<Entry[] | string> {
  const script = [
    "import importlib.metadata as m, json",
    "rows = []",
    "for d in m.distributions():",
    "    md = d.metadata",
    "    classifiers = [c.split(' :: ')[-1] for c in (md.get_all('Classifier') or []) if c.startswith('License ::')]",
    "    field = (md.get('License') or '').strip().splitlines()",
    "    rows.append({'name': md['Name'], 'version': md['Version'], 'expression': md.get('License-Expression') or '', 'classifiers': classifiers, 'field': field[0] if field else ''})",
    "print(json.dumps(rows))",
  ].join("\n");
  const ran = await run(venvPython, ["-I", "-c", script]);
  if (ran.code !== 0) return `the engine's Python environment did not answer (${venvPython}): run npm run setup`;
  const rows = JSON.parse(ran.output) as { name: string; version: string; expression: string; classifiers: string[]; field: string }[];
  return rows.map((row) => {
    // The expression when the package writes one, then its classifiers, then
    // the free-text License field (protobuf and tzdata have only that).
    const mapped = (row.classifiers.length ? row.classifiers : row.field ? [row.field] : []).map((c) => CLASSIFIERS[c] ?? c);
    const license = row.expression || (mapped.length ? [...new Set(mapped)].join(" OR ") : "(none declared)");
    return { source: "python", name: row.name, version: row.version, license, devOnly: PYTHON_DEV.has(row.name.toLowerCase()), verdict: judge(row.name, license) };
  });
}

function setupEntries(): Entry[] {
  const lock = JSON.parse(readFileSync(join(repoRoot, "tools", "flyway-lock.json"), "utf8")) as {
    jre: Record<string, { version: string }>;
    jars: { name: string }[];
  };
  const jars = lock.jars.map((jar): Entry => {
    const [, version = "?"] = /-(\d[\w.]*)\.jar$/.exec(jar.name) ?? [];
    const name = jar.name.replace(/-\d[\w.]*\.jar$/, "");
    const license = JARS.find(([pattern]) => pattern.test(jar.name))?.[1] ?? "(none declared)";
    return { source: "setup", name, version, license, devOnly: true, verdict: judge(name, license) };
  });
  const jreVersion = Object.values(lock.jre)[0]?.version ?? "?";
  const jreLicense = "GPL-2.0-only WITH Classpath-exception-2.0";
  return [...jars, { source: "setup", name: "Eclipse Temurin JRE", version: jreVersion, license: jreLicense, devOnly: true, verdict: judge("Eclipse Temurin JRE", jreLicense) }];
}

// What the sandbox serves besides its npm packages: the two wheels it loads in
// Pyodide, named by Pyodide's lock (their licences as their METADATA declares
// them), and the CPython standard library inside Pyodide's own files.
const WHEEL_LICENSES: Record<string, string> = { protobuf: "BSD-3-Clause", tzdata: "Apache-2.0" };

function sandboxEntries(): Entry[] | string {
  let wheels: { name: string; file: string }[];
  try {
    wheels = lockedWheels();
  } catch (error) {
    return `the sandbox's wheels could not be read from Pyodide's lock (${error instanceof Error ? error.message : String(error)}): npm install`;
  }
  const entries = wheels.map((wheel): Entry => {
    const version = wheel.file.split("-")[1] ?? "?";
    const license = WHEEL_LICENSES[wheel.name] ?? "(none declared)";
    return { source: "setup", name: `${wheel.name} (wheel for Pyodide)`, version, license, devOnly: false, verdict: judge(wheel.name, license) };
  });
  return [...entries, { source: "setup", name: "CPython standard library (in Pyodide)", version: "3.13", license: "PSF-2.0", devOnly: false, verdict: judge("cpython", "PSF-2.0") }];
}

export type Inventory = { readonly entries: readonly Entry[]; readonly unknown: readonly Entry[]; readonly notRead: readonly string[] };

export async function licenseInventory(): Promise<Inventory> {
  const python = await pythonEntries();
  const sandbox = sandboxEntries();
  const entries = [...npmEntries(), ...(typeof python === "string" ? [] : python), ...setupEntries(), ...(typeof sandbox === "string" ? [] : sandbox)];
  const notRead = [python, sandbox].filter((part): part is string => typeof part === "string");
  return { entries, unknown: entries.filter((entry) => entry.verdict === ""), notRead };
}

export function writeReport(inventory: Inventory): string {
  const dir = join(repoRoot, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "licenses.json");
  writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
  return file;
}

// -- The notices the demo carries -----------------------------------------------------------
//
// The demo (dist/demo) serves other people's code: the npm packages its three
// parts bundle or copy, Pyodide and PGlite with what they hold, the two wheels
// and CPython's standard library, the fonts and the icons. Their licences ask
// for their notices in every copy (MIT and BSD the copyright and the licence,
// Apache-2.0 the NOTICE files too, MPL-2.0 where Pyodide's source is, PSF-2.0
// and OFL-1.1 their own). THIRD-PARTY-NOTICES.txt holds, for each, its name,
// version and licence, and the licence text read from its own files.
//
// The npm packages are those the demo's workspaces need at run time, followed
// as Node resolves them, with optional peers and the native binaries of one
// platform left out (no browser can run them, and they would make the file
// differ from one machine to another): more than the bundles hold (Next.js and
// Apollo Server bring tools no browser receives), so that none is missing. The
// workspaces themselves are the project's own code. One entry per name and
// version, however many copies npm installed.

/** The workspaces whose builds make the demo: the site, the console and the sandbox, with what they depend on. */
const DEMO_WORKSPACES = ["apps/site", "apps/console", "packages/sandbox"];
/** A package's own licence files, at its root. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

type LockPackage = {
  readonly version?: string;
  readonly license?: string;
  /** Set on the native binaries of one platform. */
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly link?: boolean;
  readonly resolved?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
};

export type Notice = {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Where its source is, for a licence that asks it said (MPL-2.0) or files served compiled. */
  readonly source?: string;
  /** What the entry also covers, or why a text is not the package's own file. */
  readonly note?: string;
  /** Its licence files, each with the path it was read from. */
  readonly texts: readonly { readonly file: string; readonly text: string }[];
  /** For a package that ships no licence file: the standard text of each licence it declares, from another package's
   * own file under that licence (STANDARD_TEXTS). */
  readonly standard?: readonly { readonly licence: string; readonly from: string; readonly text: string; readonly holder: boolean }[];
};

/**
 * Where the standard text of a licence is read, for a package that ships none: another package's own licence file,
 * under the same licence. MIT and BSD-3-Clause name a copyright holder: the package's own line, built from the author
 * its package.json declares, replaces the file's. Apache-2.0 and MPL-2.0 name none in their text.
 */
const STANDARD_TEXTS: Readonly<Record<string, { readonly from: string; readonly holder: boolean }>> = {
  "MIT": { from: "node_modules/react/LICENSE", holder: true },
  "BSD-3-Clause": { from: "node_modules/qs/LICENSE.md", holder: true },
  "Apache-2.0": { from: "node_modules/@electric-sql/pglite/LICENSE", holder: false },
  "MPL-2.0": { from: "node_modules/axe-core/LICENSE", holder: false },
};

/** The standard text of each licence a package declares but ships no file of, with its own copyright line. */
function standardTexts(expression: string, dir: string, name: string): { licence: string; from: string; text: string; holder: boolean }[] {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { author?: string | { name?: string; email?: string } };
  const author = typeof manifest.author === "string" ? manifest.author
    : manifest.author?.name ? `${manifest.author.name}${manifest.author.email ? ` <${manifest.author.email}>` : ""}` : null;
  const holder = author ?? `the authors of ${name}`;
  return [...new Set(alternatives(expression).flat())].map((licence) => {
    const standard = STANDARD_TEXTS[licence];
    if (standard === undefined) throw new Error(`${name} declares ${licence} and ships no licence file: tools/licenses.ts has no standard text for it`);
    const path = join(repoRoot, standard.from);
    if (!existsSync(path)) throw new Error(`the standard text of ${licence} is read from ${standard.from}, which is not installed: npm install`);
    let text = readFileSync(path, "utf8").trim();
    if (standard.holder) {
      const lines = text.split(/\r?\n/);
      const at = lines.findIndex((line) => line.startsWith("Copyright"));
      if (at < 0) throw new Error(`${standard.from} has no copyright line to put ${name}'s in`);
      lines[at] = `Copyright (c) ${holder}`;
      text = lines.join("\n");
    }
    return { licence, from: standard.from, text, holder: standard.holder };
  });
}

function licenceFiles(dir: string, shown: string): { file: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => LICENCE_FILE.test(name) && statSync(join(dir, name)).isFile()).sort()
    .map((name) => ({ file: `${shown}/${name}`, text: readFileSync(join(dir, name), "utf8").trim() }));
}

/** The npm packages the demo's workspaces need at run time, by their path in the lockfile, workspaces left out. */
export function demoNpmPackages(): Map<string, { name: string; version: string; license: string; path: string }> {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as { packages: Record<string, LockPackage> };
  const found = new Map<string, { name: string; version: string; license: string; path: string }>();
  const seen = new Set<string>();
  // Where Node finds `dependency` from the package at `from`: its own node_modules, then each parent's.
  const resolveFrom = (from: string, dependency: string): string | null => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${dependency}`;
      if (lock.packages[candidate]) return candidate;
      if (!base) return null;
      const at = base.lastIndexOf("node_modules/");
      base = at < 0 ? "" : base.slice(0, at).replace(/\/$/, "");
    }
  };
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const entry = lock.packages[path];
    if (entry === undefined) return;
    if (entry.link) {
      if (entry.resolved) visit(entry.resolved);  // a workspace: its own code, and what it needs
      return;
    }
    if (path.includes("node_modules/")) {
      if (entry.os !== undefined || entry.cpu !== undefined) return;  // a native binary of one platform: never in a browser
      if (!existsSync(join(repoRoot, path))) return;  // an optional package not installed here
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      found.set(path, { name, version: entry.version ?? "?", license: entry.license ?? "(none declared)", path });
    }
    const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, meta]) => meta.optional).map(([name]) => name));
    const needed = [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name))];
    for (const dependency of needed) {
      const at = resolveFrom(path, dependency);
      if (at !== null) visit(at);
    }
  };
  for (const workspace of DEMO_WORKSPACES) visit(workspace);
  return found;
}

/** The licence texts of the two wheels (their dist-info) and of CPython (its installation's LICENSE.txt), read with
 * the engine's Python: Pyodide's python_stdlib.zip carries none. */
async function pythonTexts(wheelsDir: string): Promise<{ wheels: Record<string, { file: string; text: string }[]>; cpython: { file: string; text: string } | null }> {
  const script = [
    "import glob, json, os, sys, sysconfig, zipfile",
    "wheels = {}",
    "for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.whl'))):",
    "    with zipfile.ZipFile(path) as z:",
    "        names = [n for n in z.namelist() if '.dist-info/' in n and any(k in n.rsplit('/', 1)[-1].upper() for k in ('LICEN', 'COPYING', 'NOTICE'))]",
    "        wheels[os.path.basename(path)] = [{'file': n, 'text': z.read(n).decode('utf-8', 'replace').strip()} for n in sorted(names)]",
    "cpython = None",
    "for candidate in (os.path.join(sys.base_prefix, 'LICENSE.txt'), os.path.join(sysconfig.get_paths()['stdlib'], 'LICENSE.txt')):",
    "    if os.path.exists(candidate):",
    "        cpython = {'file': candidate, 'text': open(candidate, encoding='utf-8').read().strip()}",
    "        break",
    "print(json.dumps({'wheels': wheels, 'cpython': cpython}))",
  ].join("\n");
  const ran = await run(venvPython, ["-I", "-c", script, wheelsDir]);
  if (ran.code !== 0) throw new Error(`the engine's Python environment did not read the licences (${venvPython}): run npm run setup\n${ran.output.slice(-1000)}`);
  return JSON.parse(ran.output) as { wheels: Record<string, { file: string; text: string }[]>; cpython: { file: string; text: string } | null };
}

/** What an entry says for a package that ships no licence file: what its package.json declares, and where its
 * source, which holds the licence, is. */
function withoutLicenceFile(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    author?: string | { name?: string; email?: string };
    repository?: string | { url?: string; directory?: string };
  };
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const url = repository
    ?.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1");
  const directory = typeof manifest.repository === "object" && manifest.repository.directory ? ` (${manifest.repository.directory})` : "";
  return "The package has no licence file: its package.json declares the licence above"
    + (author ? `, by ${author}` : "") + (url ? `; its source, with the licence, is at ${url}${directory}` : "") + ".";
}

/** Every entry of the demo's notices, the npm packages by name, then the files that are not npm's. */
export async function demoNotices(): Promise<Notice[]> {
  const notices: Notice[] = [];
  const kept = new Set<string>();
  for (const pkg of [...demoNpmPackages().values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))) {
    if (kept.has(`${pkg.name}@${pkg.version}`)) continue;
    kept.add(`${pkg.name}@${pkg.version}`);
    const dir = join(repoRoot, pkg.path);
    const texts = licenceFiles(dir, pkg.path);
    let source: string | undefined;
    let note: string | undefined;
    if (pkg.name === "pyodide") {
      source = `https://github.com/pyodide/pyodide, tag ${pkg.version}; and the npm package pyodide@${pkg.version}`;
      note = "The package has no licence file. Exhibit A of the MPL-2.0: This Source Code Form is subject to the terms of the "
        + "Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at "
        + "https://mozilla.org/MPL/2.0/. Pyodide's files hold CPython compiled to WebAssembly (see \"CPython standard library\") "
        + "and the runtime Emscripten generates.";
    } else if (pkg.name === "@electric-sql/pglite") {
      source = `https://github.com/electric-sql/pglite, tag @electric-sql/pglite@${pkg.version}; and the npm package @electric-sql/pglite@${pkg.version}`;
      note = "PGlite's files hold PostgreSQL 18 compiled to WebAssembly, under the PostgreSQL Licence. The package carries no "
        + "copy of it: the text below is the licence the PostgreSQL project publishes (https://www.postgresql.org/about/licence/), "
        + "with the years its files in PGlite state.";
      texts.push({ file: "tools/notices/postgresql-licence.txt", text: readFileSync(join(repoRoot, "tools", "notices", "postgresql-licence.txt"), "utf8").trim() });
    } else if (pkg.name === "next") {
      // Next.js ships copies of other packages, compiled into its own files: their licence files too.
      const compiled = join(dir, "dist", "compiled");
      if (existsSync(compiled)) {
        for (const name of readdirSync(compiled).sort()) {
          const inner = name.startsWith("@") ? readdirSync(join(compiled, name)).sort().map((each) => `${name}/${each}`) : [name];
          for (const each of inner) texts.push(...licenceFiles(join(compiled, each), `${pkg.path}/dist/compiled/${each}`));
        }
        note = "Next.js carries compiled copies of other packages in next/dist/compiled: their licence files follow its own.";
      }
    }
    if (texts.length === 0 && note === undefined) note = withoutLicenceFile(dir);
    const standard = texts.length === 0 ? standardTexts(pkg.license, dir, pkg.name) : [];
    notices.push({ name: pkg.name, version: pkg.version, license: pkg.license, ...(source ? { source } : {}), ...(note ? { note } : {}), texts,
      ...(standard.length ? { standard } : {}) });
  }
  const wheels = lockedWheels();
  const read = await pythonTexts(wheelsHome(repoRoot).dir);
  for (const wheel of wheels) {
    notices.push({
      name: `${wheel.name} (wheel for Pyodide)`, version: wheel.file.split("-")[1] ?? "?", license: WHEEL_LICENSES[wheel.name] ?? "(none declared)",
      source: `${wheel.file}, from Pyodide's distribution`, texts: (read.wheels[wheel.file] ?? []).map((each) => ({ file: `${wheel.file}/${each.file}`, text: each.text })),
    });
  }
  const pyodideVersion = (JSON.parse(readFileSync(join(pyodideDir(), "package.json"), "utf8")) as { version: string }).version;
  notices.push({
    name: "CPython standard library (in Pyodide)", version: `as built into Pyodide ${pyodideVersion}`, license: "PSF-2.0",
    note: "Pyodide's python_stdlib.zip carries no licence file: the text below is CPython's own LICENSE.txt, from the "
      + "installation the engine's Python environment uses (the same licence, for the same 3.13 series).",
    texts: read.cpython ? [{ file: "LICENSE.txt of CPython 3.13", text: read.cpython.text }] : [],
  });
  const design = join(repoRoot, "packages", "design");
  notices.push({ name: "Archivo (font)", version: "the files in packages/design/fonts", license: "OFL-1.1", texts: licenceFiles(join(design, "fonts"), "packages/design/fonts").filter((each) => each.file.includes("archivo")) });
  notices.push({ name: "Atkinson Hyperlegible Next (font)", version: "the files in packages/design/fonts", license: "OFL-1.1", texts: licenceFiles(join(design, "fonts"), "packages/design/fonts").filter((each) => each.file.includes("atkinson")) });
  const phosphor = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")).packages["node_modules/@phosphor-icons/core"] as LockPackage | undefined;
  notices.push({
    name: "Phosphor Icons (@phosphor-icons/core)", version: phosphor?.version ?? "?", license: phosphor?.license ?? "MIT",
    note: "Its icons are drawn into the design package's own code, which both apps bundle.",
    texts: licenceFiles(join(repoRoot, "node_modules", "@phosphor-icons", "core"), "node_modules/@phosphor-icons/core"),
  });
  return notices;
}

/** The notices as the text file the demo serves. */
export function noticesText(notices: readonly Notice[]): string {
  const rule = "=".repeat(78);
  const lines = [
    "THIRD-PARTY NOTICES",
    "",
    "The demo at this address serves code and data of the packages below, each under its own licence: npm packages the",
    "site, the console and the sandbox bundle or copy, Pyodide and PGlite with what they hold, two Python wheels, the",
    "CPython standard library, two fonts and an icon set. For each: its name, version and licence, then its licence",
    "text, read from its own files. The project's own code is under its LICENSE, at the address in the About panel.",
    "",
  ];
  for (const notice of notices) {
    lines.push(rule, `${notice.name} ${notice.version}`, `Licence: ${notice.license}`);
    if (notice.source) lines.push(`Source: ${notice.source}`);
    if (notice.note) lines.push(notice.note);
    if (notice.texts.length === 0) lines.push("No licence file was found for it.");
    for (const text of notice.texts) lines.push("", `--- ${text.file}`, "", text.text);
    for (const text of notice.standard ?? []) {
      lines.push("", `--- Standard text of the declared licence (${text.licence}); the package ships no licence file of its own. `
        + `Taken from ${text.from}${text.holder ? ", with the copyright line built from the package's package.json" : ""}.`, "", text.text);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes the notices to a file: what they hold, and the entries with no licence file of their own. */
export async function writeDemoNotices(file: string): Promise<{ notices: readonly Notice[]; withoutFile: readonly string[] }> {
  const notices = await demoNotices();
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, noticesText(notices));
  return { notices, withoutFile: notices.filter((notice) => notice.texts.length === 0).map((notice) => `${notice.name} ${notice.version}`) };
}

/**
 * What a built demo serves that its notices do not name: the npm packages its worker bundles (its source map lists
 * them), Pyodide, PGlite, the wheels and the standard library it copies, the fonts it serves. The Next.js bundles of
 * the site and the console keep no module paths, so their packages cannot be read from them: the notices name every
 * package the two apps need at run time instead (demoNpmPackages), more than they bundle.
 */
export function unnamedInDemo(demo: string, notices: readonly Notice[]): string[] {
  const named = new Set(notices.map((notice) => notice.name));
  const missing: string[] = [];
  const map = join(demo, "sandbox", "backend.js.map");
  if (!existsSync(map)) return [`${map} is missing: the worker's packages cannot be read`];
  for (const source of (JSON.parse(readFileSync(map, "utf8")) as { sources: string[] }).sources) {
    const at = source.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const parts = source.slice(at + "node_modules/".length).split("/");
    const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0] ?? "";
    if (!named.has(name)) missing.push(`${name} (bundled into sandbox/backend.js)`);
  }
  const has = (path: string) => existsSync(join(demo, path));
  if (has("sandbox/pyodide/pyodide.asm.wasm") && !named.has("pyodide")) missing.push("pyodide (sandbox/pyodide)");
  if (has("sandbox/pyodide/python_stdlib.zip") && !named.has("CPython standard library (in Pyodide)")) missing.push("CPython's standard library (sandbox/pyodide)");
  if (has("sandbox/pglite") && !named.has("@electric-sql/pglite")) missing.push("@electric-sql/pglite (sandbox/pglite)");
  if (has("sandbox/pyodide")) {
    for (const file of readdirSync(join(demo, "sandbox", "pyodide")).filter((name) => name.endsWith(".whl"))) {
      if (!notices.some((notice) => notice.source?.startsWith(file))) missing.push(`${file} (sandbox/pyodide)`);
    }
  }
  const fonts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? fonts(join(dir, entry.name)) : /\.(woff2?|ttf|otf)$/.test(entry.name) ? [entry.name] : []);
  for (const font of new Set(fonts(demo))) {
    const family = font.startsWith("archivo") ? "Archivo (font)" : font.startsWith("atkinson-hyperlegible-next") ? "Atkinson Hyperlegible Next (font)" : null;
    if (family === null || !named.has(family)) missing.push(`${font} (a font served)`);
  }
  return [...new Set(missing)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const inventory = await licenseInventory();
  const byLicense = new Map<string, number>();
  for (const entry of inventory.entries) byLicense.set(entry.license, (byLicense.get(entry.license) ?? 0) + 1);
  for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(5)}  ${license}`);
  for (const entry of inventory.entries.filter((e) => e.verdict.startsWith("exception"))) console.log(`exception  ${entry.source} ${entry.name} ${entry.version}: ${entry.verdict.slice(11)}`);
  for (const problem of inventory.notRead) console.log(`not read: ${problem}`);
  for (const entry of inventory.unknown) console.log(`NOT ALLOWED  ${entry.source} ${entry.name} ${entry.version}: ${entry.license}`);
  console.log(`${inventory.entries.length} packages, ${inventory.unknown.length} outside the policy; report in ${writeReport(inventory)}`);
  const noticesFile = join(repoRoot, "reports", "THIRD-PARTY-NOTICES.txt");
  const written = await writeDemoNotices(noticesFile);
  console.log(`the demo's notices: ${written.notices.length} entries in ${noticesFile}`);
  for (const entry of written.withoutFile) console.log(`no licence file  ${entry}`);
  process.exitCode = inventory.unknown.length > 0 || inventory.notRead.length > 0 ? 1 : 0;
}
