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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedWheels } from "../packages/sandbox/src/engine/build/wheels.ts";
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const inventory = await licenseInventory();
  const byLicense = new Map<string, number>();
  for (const entry of inventory.entries) byLicense.set(entry.license, (byLicense.get(entry.license) ?? 0) + 1);
  for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(5)}  ${license}`);
  for (const entry of inventory.entries.filter((e) => e.verdict.startsWith("exception"))) console.log(`exception  ${entry.source} ${entry.name} ${entry.version}: ${entry.verdict.slice(11)}`);
  for (const problem of inventory.notRead) console.log(`not read: ${problem}`);
  for (const entry of inventory.unknown) console.log(`NOT ALLOWED  ${entry.source} ${entry.name} ${entry.version}: ${entry.license}`);
  console.log(`${inventory.entries.length} packages, ${inventory.unknown.length} outside the policy; report in ${writeReport(inventory)}`);
  process.exitCode = inventory.unknown.length > 0 || inventory.notRead.length > 0 ? 1 : 0;
}
