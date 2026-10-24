// npm run gateway: the console's API on 127.0.0.1:4621 and the site's on
// 127.0.0.1:4622 (both at /graphql, with /health beside them), in front of
// the engine at ENGINE_URL. Settings and secrets: config.ts.
//
// DEMONSTRATION MODE ONLY: signing in picks a person of the demo, which is
// not authentication; the log says so at every start, and the gateway refuses
// to start any other way.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFree } from "../../../../tools/lib/ports.ts";
import { ConfigError, loadConfig, REAL_AUTH } from "./config.ts";
import { startGateway, type Gateway } from "./gateway.ts";
import { connectEngine, type EngineConnection } from "./grpc.ts";
import { createLogger } from "./log.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const clock = () => new Date();
const logger = createLogger({ clock });

let connection: EngineConnection | null = null;
let gateway: Gateway | null = null;
try {
  const config = await loadConfig(process.env, join(repoRoot, ".data"));
  for (const endpoint of config.endpoints) await assertFree(config.ports[endpoint], `the gateway's ${endpoint} API`);
  if (config.endpoints.includes("internal")) {
    logger.log("warn", "DEMONSTRATION MODE: signing in to the console's API picks a person of the demo, and is not authentication", {
      realDeploymentNeeds: REAL_AUTH,
    });
  }
  const engine = connectEngine(config.engineUrl, config.engineToken);
  connection = engine;
  const health = await engine.health();
  logger.log(health === "SERVING" ? "info" : "warn", "engine", { url: config.engineUrl, health });
  gateway = await startGateway(config, { engine: engine.client, engineHealth: () => engine.health(), logger, clock });
  logger.log("info", "listening", {
    console: gateway.internal?.url ?? null,
    site: gateway.public?.url ?? null,
    production: config.production,
    consoleOrigins: config.origins.internal,
    siteOrigins: config.origins.public,
  });
  const running = gateway;
  const stop = async (signal: string) => {
    logger.log("info", "stopping", { signal });
    await running.close();
    engine.close();
    logger.log("info", "stopped");
  };
  process.once("SIGINT", (signal) => void stop(signal));
  process.once("SIGTERM", (signal) => void stop(signal));
} catch (error) {
  logger.log("error", error instanceof ConfigError ? "refusing to start" : "could not start", {
    error: error instanceof Error ? error.message : String(error),
  });
  await gateway?.close();
  connection?.close();
  process.exitCode = 1;
}
