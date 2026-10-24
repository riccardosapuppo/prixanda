// The engine over gRPC: Connect's gRPC transport on Node's HTTP/2, as in the
// stage 0 prototype. The internal token rides on every call from here, the
// only place that knows it; the core writes the rest of the metadata.
import { randomUUID } from "node:crypto";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { Health, HealthCheckResponse_ServingStatus } from "contracts/grpc/health/v1/health";
import { createEngineClient, type EngineClient } from "../core/engine.ts";

export type EngineConnection = {
  readonly client: EngineClient;
  /** SERVING, NOT_SERVING, or UNREACHABLE when the engine does not answer. */
  health(): Promise<string>;
  /** Closes the HTTP/2 connection, so the process can end. */
  close(): void;
};

export function connectEngine(url: string, token: string): EngineConnection {
  const sessions = new Http2SessionManager(url, { pingIntervalMs: 30_000, idleConnectionTimeoutMs: 300_000 });
  const authorize: Interceptor = (next) => (request) => {
    request.header.set("authorization", `Bearer ${token}`);
    return next(request);
  };
  const transport = createGrpcTransport({ baseUrl: url, sessionManager: sessions, interceptors: [authorize] });
  const health = createClient(Health, transport);
  return {
    client: createEngineClient(transport),
    async health() {
      try {
        const answer = await health.check({ service: "" }, { timeoutMs: 2_000, headers: { "x-request-id": `health-${randomUUID()}` } });
        return HealthCheckResponse_ServingStatus[answer.status] ?? "UNKNOWN";
      } catch {
        return "UNREACHABLE";
      }
    },
    close() {
      sessions.abort();
    },
  };
}
