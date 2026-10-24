// Where things live. Everything the tools create stays inside the
// repository: downloads in .tools/, local PostgreSQL clusters in .data/, the
// Python environment in .venv/ (all three ignored by git).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const toolsDir = join(repoRoot, ".tools");
export const dataDir = join(repoRoot, ".data");
export const migrationsDir = join(repoRoot, "db", "migrations");
export const commerceDir = join(repoRoot, "services", "commerce");
export const platformKey = `${process.platform}-${process.arch}`;

export const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

// The engine's virtual environment: .venv/Scripts on Windows, .venv/bin elsewhere.
export const venvPython = join(repoRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin", exe("python"));

// The project's own ports (46xx), never the usual 3000s, 5432 or 8080. Two
// checks of two copies of the repository can run side by side with
// CHECK_POSTGRES_PORT, DEV_POSTGRES_PORT, CHECK_ENGINE_PORT and, for the
// gateway's tests, CHECK_GATEWAY_INTERNAL_PORT, CHECK_GATEWAY_PUBLIC_PORT and
// CHECK_FAKE_ENGINE_PORT; MEASURE_POSTGRES_PORT moves the measurements'
// cluster (npm run measure). The engine listens where ENGINE_URL, the
// address the gateway calls it at, points.
export const PORTS = {
  postgresDev: Number(process.env["DEV_POSTGRES_PORT"] ?? 4601),
  postgresCheck: Number(process.env["CHECK_POSTGRES_PORT"] ?? 4602),
  postgresMeasure: Number(process.env["MEASURE_POSTGRES_PORT"] ?? 4604),
  engine: Number(new URL(process.env["ENGINE_URL"] ?? "http://127.0.0.1:4611").port || 4611),
  engineCheck: Number(process.env["CHECK_ENGINE_PORT"] ?? 4612),
  gatewayCheckInternal: Number(process.env["CHECK_GATEWAY_INTERNAL_PORT"] ?? 4621),
  gatewayCheckPublic: Number(process.env["CHECK_GATEWAY_PUBLIC_PORT"] ?? 4622),
  fakeEngineCheck: Number(process.env["CHECK_FAKE_ENGINE_PORT"] ?? 4613),
} as const;
