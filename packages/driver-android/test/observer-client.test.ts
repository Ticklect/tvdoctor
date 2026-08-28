import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AndroidObserverClient,
  ObserverFrameDecoder,
  encodeObserverFrame,
  type ObserverRequest,
  type ObserverResponse,
} from "../src/index.js";

const TOKEN = "d".repeat(64);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close").catch(() => undefined);
  }));
});

async function listen(
  onRequest: (request: ObserverRequest, socket: Socket) => void,
): Promise<number> {
  const server = createServer((socket) => {
    const decoder = new ObserverFrameDecoder();
    socket.on("data", (chunk) => {
      for (const value of decoder.push(chunk)) onRequest(value as ObserverRequest, socket);
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind TCP.");
  return address.port;
}

function write(socket: Socket, response: ObserverResponse): void {
  socket.write(encodeObserverFrame(response));
}

function hello(request: ObserverRequest, socket: Socket): boolean {
  if (request.type !== "hello") return false;
  write(socket, {
    version: 2,
    id: request.id,
    ok: true,
    type: "hello",
    protocolVersion: 2,
    observerVersion: "test",
    serviceEnabled: true,
  });
  return true;
}

describe("Android observer client", () => {
  it("correlates out-of-order responses on one persistent connection", async () => {
    const pending: { request: ObserverRequest; socket: Socket }[] = [];
    const port = await listen((request, socket) => {
      if (hello(request, socket)) return;
      pending.push({ request, socket });
      if (pending.length !== 2) return;
      const second = pending[1];
      const first = pending[0];
      if (second === undefined || first === undefined) return;
      write(second.socket, { version: 2, id: second.request.id, ok: true, type: "second" });
      write(first.socket, { version: 2, id: first.request.id, ok: true, type: "first" });
    });
    const client = await AndroidObserverClient.connect({ port, token: TOKEN, hostVersion: "test" });
    const [first, second] = await Promise.all([
      client.request({ type: "ping" }),
      client.request({ type: "device_info" }),
    ]);
    expect(first.type).toBe("first");
    expect(second.type).toBe("second");
    expect(client.metrics()).toMatchObject({
      framesSent: 3,
      framesReceived: 3,
      bytesSent: expect.any(Number),
      bytesReceived: expect.any(Number),
    });
    expect(client.metrics().bytesSent).toBeGreaterThan(0);
    expect(client.metrics().bytesReceived).toBeGreaterThan(0);
    client.close();
  });

  it("cancels timed-out requests and rejects their late responses as stale", async () => {
    let timedOutId: number | null = null;
    const port = await listen((request, socket) => {
      if (hello(request, socket)) return;
      if (request.type === "ping") {
        timedOutId = request.id;
        return;
      }
      if (request.type === "cancel") {
        if (timedOutId !== null) write(socket, { version: 2, id: timedOutId, ok: true, type: "late" });
        write(socket, { version: 2, id: request.id, ok: true, type: "cancel" });
        return;
      }
      write(socket, { version: 2, id: request.id, ok: true, type: "device_info" });
    });
    const client = await AndroidObserverClient.connect({ port, token: TOKEN, hostVersion: "test" });
    await expect(client.request({ type: "ping" }, { timeoutMs: 30 })).rejects.toThrow(/timed out/u);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(client.request({ type: "device_info" })).resolves.toMatchObject({ type: "device_info" });
    client.close();
  });

  it("fails pending work cleanly when the observer disconnects", async () => {
    const port = await listen((request, socket) => {
      if (hello(request, socket)) return;
      socket.destroy();
    });
    const client = await AndroidObserverClient.connect({ port, token: TOKEN, hostVersion: "test" });
    await expect(client.request({ type: "ping" })).rejects.toThrow(/disconnected/u);
    client.close();
  });
});
