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

// The project's own ports (46xx), never the usual 3000s, 5432 or 8080.
export const PORTS = {
  postgresDev: 4601,
  postgresCheck: 4602,
} as const;
