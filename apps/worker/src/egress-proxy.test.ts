import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy } from "./egress-proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return address.port;
}

function readBytes(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= length) {
        socket.off("data", onData);
        socket.off("error", reject);
        const extra = buffered.subarray(length);
        if (extra.length > 0) socket.unshift(extra);
        resolve(buffered.subarray(0, length));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function socksConnect(
  proxyUrl: string,
  host: string,
  port: number,
): Promise<{ reply: number; socket: Socket }> {
  const proxyPort = Number(new URL(proxyUrl).port);
  const socket = connect(proxyPort, "127.0.0.1");
  cleanups.push(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  expect([...(await readBytes(socket, 2))]).toEqual([0x05, 0x00]);
  const hostBytes = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
      hostBytes,
      portBytes,
    ]),
  );
  const response = await readBytes(socket, 10);
  return { reply: response[1]!, socket };
}

describe("egress proxy", () => {
  it("tunnels to an allowed destination", async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = await startEgressProxy({ allowLocal: true, name: "test" });
    cleanups.push(proxy.close);

    const { reply, socket } = await socksConnect(proxy.url, "localhost", echoPort);
    expect(reply).toBe(0x00);
    socket.write("ping");
    expect((await readBytes(socket, 4)).toString()).toBe("ping");
  });

  it("rejects loopback destinations when local access is disabled", async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = await startEgressProxy({ allowLocal: false, name: "test" });
    cleanups.push(proxy.close);
    const warn = console.warn;
    console.warn = () => undefined;
    cleanups.push(() => {
      console.warn = warn;
    });

    const { reply } = await socksConnect(proxy.url, "127.0.0.1", echoPort);
    expect(reply).toBe(0x02);
  });

  it("rejects private and link-local destinations", async () => {
    const proxy = await startEgressProxy({ allowLocal: true, name: "test" });
    cleanups.push(proxy.close);
    const warn = console.warn;
    console.warn = () => undefined;
    cleanups.push(() => {
      console.warn = warn;
    });

    for (const host of ["169.254.169.254", "10.0.0.1", "192.168.1.10"]) {
      const { reply } = await socksConnect(proxy.url, host, 80);
      expect(reply).toBe(0x02);
    }
  });

  it("refuses commands other than CONNECT", async () => {
    const proxy = await startEgressProxy({ allowLocal: true, name: "test" });
    cleanups.push(proxy.close);
    const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1");
    cleanups.push(() => {
      socket.destroy();
    });
    await once(socket, "connect");
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readBytes(socket, 2);
    socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 1, 1, 1, 0, 80]));
    expect((await readBytes(socket, 10))[1]).toBe(0x07);
  });
});
