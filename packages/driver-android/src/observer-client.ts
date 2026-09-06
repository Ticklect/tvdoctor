import { createConnection, type Socket } from "node:net";
import {
  ANDROID_OBSERVER_PROTOCOL_VERSION,
  ObserverFrameDecoder,
  encodeObserverFrame,
  parseObserverResponse,
  validateObserverRequest,
  type ObserverRequest,
  type ObserverRequestPayload,
  type ObserverResponse,
} from "./observer-protocol.js";

interface PendingRequest {
  readonly resolve: (response: ObserverResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort: () => void;
}

export interface AndroidObserverClientOptions {
  readonly host?: string;
  readonly port: number;
  readonly token: string;
  readonly hostVersion: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly createSocket?: (port: number, host: string) => Socket;
}

export interface AndroidObserverConnection {
  request(
    request: ObserverRequestPayload,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ObserverResponse>;
  close(reason?: Error): void;
  metrics?(): AndroidObserverTransportMetrics;
}

export interface AndroidObserverTransportMetrics {
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly framesSent: number;
  readonly framesReceived: number;
}

function abortError(message = "Android observer request was cancelled."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AndroidObserverClient implements AndroidObserverConnection {
  readonly #decoder = new ObserverFrameDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #retired = new Set<number>();
  readonly #socket: Socket;
  readonly #signal: AbortSignal | undefined;
  #closed = false;
  #nextId = 1;
  #bytesSent = 0;
  #bytesReceived = 0;
  #framesSent = 0;
  #framesReceived = 0;

  private constructor(socket: Socket, options: AndroidObserverClientOptions) {
    this.#socket = socket;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#signal = options.signal;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(new Error(`Android observer transport failed: ${errorMessage(error)}`)));
    socket.on("close", () => this.#fail(new Error("Android observer disconnected.")));
    options.signal?.addEventListener("abort", () => this.close(abortError()), { once: true });
  }

  static async connect(options: AndroidObserverClientOptions): Promise<AndroidObserverClient> {
    const host = options.host ?? "127.0.0.1";
    if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) {
      throw new TypeError("Android observer port is invalid.");
    }
    if (options.signal?.aborted === true) throw abortError();
    const socket = (options.createSocket ?? createConnection)(options.port, host);
    const timeoutMs = options.connectTimeoutMs ?? 5_000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onConnect = (): void => finish();
      const onError = (error: Error): void => finish(new Error(`Could not connect to the Android observer: ${error.message}`));
      const onAbort = (): void => {
        socket.destroy();
        finish(abortError("Android observer connection was cancelled."));
      };
      const timer = setTimeout(() => {
        socket.destroy();
        finish(new Error(`Android observer connection timed out after ${String(timeoutMs)} ms.`));
      }, timeoutMs);
      socket.once("connect", onConnect);
      socket.once("error", onError);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const client = new AndroidObserverClient(socket, options);
    let hello: ObserverResponse;
    try {
      hello = await client.request({
        type: "hello",
        token: options.token,
        hostVersion: options.hostVersion,
      });
    } catch (error) {
      client.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (hello.protocolVersion !== ANDROID_OBSERVER_PROTOCOL_VERSION) {
      client.close();
      throw new Error("Android observer and host protocol versions are incompatible.");
    }
    if (hello.serviceEnabled !== true) {
      client.close();
      throw new Error("Android observer accessibility service is not enabled.");
    }
    return client;
  }

  async request(
    request: ObserverRequestPayload,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ObserverResponse> {
    if (this.#closed) throw new Error("Android observer client is closed.");
    const id = this.#nextId;
    this.#nextId += 1;
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("Android observer request identity exhausted.");
    const wireRequest = validateObserverRequest({
      ...request,
      id,
      version: ANDROID_OBSERVER_PROTOCOL_VERSION,
    } as ObserverRequest);
    const signal = options.signal ?? this.#signal;
    if (signal?.aborted === true) throw abortError();
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new TypeError("Observer request timeout must be between 1 and 60000 ms.");
    }
    return await new Promise<ObserverResponse>((resolve, reject) => {
      const retire = (error: Error, sendCancellation: boolean): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort();
        this.#rememberRetired(id);
        reject(error);
        if (sendCancellation && !this.#closed) this.#sendCancellation(id);
      };
      const onAbort = (): void => retire(abortError(), true);
      const timer = setTimeout(() => {
        retire(new Error(`Android observer request ${String(id)} timed out after ${String(timeoutMs)} ms.`), true);
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        removeAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      try {
        const frame = encodeObserverFrame(wireRequest);
        this.#socket.write(frame);
        this.#bytesSent += frame.byteLength;
        this.#framesSent += 1;
      } catch (error) {
        retire(new Error(`Could not write Android observer request: ${errorMessage(error)}`), false);
      }
    });
  }

  close(reason = new Error("Android observer client closed.")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.removeAbort();
      pending.reject(reason);
      this.#rememberRetired(id);
    }
    this.#pending.clear();
  }

  metrics(): AndroidObserverTransportMetrics {
    return {
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
      framesSent: this.#framesSent,
      framesReceived: this.#framesReceived,
    };
  }

  #sendCancellation(targetId: number): void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#rememberRetired(id);
    try {
      const frame = encodeObserverFrame(validateObserverRequest({
        version: ANDROID_OBSERVER_PROTOCOL_VERSION,
        id,
        type: "cancel",
        targetId,
      }));
      this.#socket.write(frame);
      this.#bytesSent += frame.byteLength;
      this.#framesSent += 1;
    } catch {
      // The original timeout/abort remains the authoritative failure.
    }
  }

  #rememberRetired(id: number): void {
    this.#retired.add(id);
    while (this.#retired.size > 1_024) {
      const oldest = this.#retired.values().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#retired.delete(oldest);
    }
  }

  #onData(chunk: Uint8Array): void {
    if (this.#closed) return;
    this.#bytesReceived += chunk.byteLength;
    let messages: readonly unknown[];
    try {
      messages = this.#decoder.push(chunk);
      for (const message of messages) {
        this.#framesReceived += 1;
        const response = parseObserverResponse(message);
        if (this.#retired.delete(response.id)) continue;
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
          throw new Error(`Android observer returned an unknown or stale request id ${String(response.id)}.`);
        }
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.removeAbort();
        if (!response.ok) {
          pending.reject(new Error(
            `Android observer ${response.error?.code ?? "error"}: ${response.error?.message ?? "request failed"}`,
          ));
        } else {
          pending.resolve(response);
        }
      }
    } catch (error) {
      this.#fail(new Error(`Android observer protocol failure: ${errorMessage(error)}`));
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close(error);
  }
}
