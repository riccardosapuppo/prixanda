// One JSON object per line, with the request's id when there is one: the line
// that says what happened to request X is found with the id the client got
// back. Secrets (the engine's token, cookies, CSRF tokens) and client
// addresses are never written.

export type Level = "info" | "warn" | "error";

export type Logger = {
  log(level: Level, message: string, fields?: Record<string, unknown>): void;
};

export function createLogger(options: { clock: () => Date; write?: (line: string) => void }): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return {
    log(level, message, fields = {}) {
      write(JSON.stringify({ at: options.clock().toISOString(), level, service: "gateway", msg: message, ...fields }));
    },
  };
}
