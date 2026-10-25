// A Connect transport over the engine in the page (stage 8). The gateway's
// core reaches the engine through an EngineClient, as it does over gRPC on
// Node, and does not change: this transport carries each of its calls to
// BrowserEngine.call, in binary, with the metadata the core wrote and the
// internal token, as the gRPC transport adds it; and turns the engine's gRPC
// code back into the ConnectError the core reads. The contract has unary
// calls only.
import { create, type DescMessage, type DescMethodUnary, fromBinary, isMessage, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport, type UnaryResponse } from "@connectrpc/connect";
import type { BrowserEngine, EngineReply } from "./engine-port.ts";

/** The engine's answer, or a deadline passed, or the call given up: as a gRPC client would see them. */
function settled(call: Promise<EngineReply>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<EngineReply> {
  if (signal?.aborted) return Promise.reject(new ConnectError("the call was given up", Code.Canceled));
  if (timeoutMs === undefined && signal === undefined) return call;
  return new Promise<EngineReply>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      reject(new ConnectError("the engine did not answer in time", Code.DeadlineExceeded));
    }, timeoutMs);
    const abort = () => reject(new ConnectError("the call was given up", Code.Canceled));
    signal?.addEventListener("abort", abort, { once: true });
    call.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

export function browserTransport(engine: BrowserEngine, token: string): Transport {
  return {
    async unary<I extends DescMessage, O extends DescMessage>(
      method: DescMethodUnary<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      input: MessageInitShape<I>,
    ): Promise<UnaryResponse<I, O>> {
      const metadata: Record<string, string> = {};
      new Headers(header).forEach((value, name) => {
        metadata[name] = value;
      });
      metadata["authorization"] = `Bearer ${token}`;
      const message = isMessage(input, method.input) ? input : create(method.input, input);
      let reply: EngineReply;
      try {
        reply = await settled(engine.call(method.parent.typeName, method.name, metadata, toBinary(method.input, message)), signal, timeoutMs);
      } catch (error) {
        if (error instanceof ConnectError) throw error;
        // The engine in the page broke, rather than answered: as a server that failed.
        throw new ConnectError(error instanceof Error ? error.message : String(error), Code.Internal);
      }
      if (!reply.ok) throw new ConnectError(reply.message, reply.code in Code ? (reply.code as Code) : Code.Unknown);
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        message: fromBinary(method.output, reply.response),
        trailer: new Headers(),
      };
    },
    stream() {
      return Promise.reject(new ConnectError("the engine in the page answers unary calls only", Code.Unimplemented));
    },
  };
}
