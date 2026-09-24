import { isIP, type Server, type Socket, connect, createServer } from "node:net";
import { resolvePublicHostAddresses } from "@responder/core/integrations/custom-mcp";

const SOCKS_VERSION = 0x05;
const NO_AUTHENTICATION = 0x00;
const NO_ACCEPTABLE_METHODS = 0xff;
const CONNECT_COMMAND = 0x01;
const ADDRESS_IPV4 = 0x01;
const ADDRESS_DOMAIN = 0x03;
const ADDRESS_IPV6 = 0x04;
const REPLY_SUCCEEDED = 0x00;
const REPLY_GENERAL_FAILURE = 0x01;
const REPLY_NOT_ALLOWED = 0x02;
const REPLY_HOST_UNREACHABLE = 0x04;
const REPLY_COMMAND_NOT_SUPPORTED = 0x07;
const REPLY_ADDRESS_NOT_SUPPORTED = 0x08;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

class SocksReplyError extends Error {
  constructor(
    readonly reply: number,
    message: string,
  ) {
    super(message);
  }
}

/** Buffers socket data so the handshake can read exact byte counts. */
class SocketReader {
  private buffered = Buffer.alloc(0);
  private pending: { length: number; resolve: (value: Buffer) => void } | null =
    null;
  private failure: Error | null = null;
  private failPending: ((error: Error) => void) | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.once("close", () => this.fail(new Error("SOCKS client disconnected")));
    socket.once("error", (error) => this.fail(error));
  }

  read(length: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { length, resolve };
      this.failPending = reject;
      this.flush();
    });
  }

  /** Stops buffering and returns bytes that arrived after the handshake. */
  release(): Buffer {
    this.socket.off("data", this.onData);
    const remaining = this.buffered;
    this.buffered = Buffer.alloc(0);
    return remaining;
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.flush();
  };

  private flush() {
    if (!this.pending || this.buffered.length < this.pending.length) return;
    const { length, resolve } = this.pending;
    this.pending = null;
    this.failPending = null;
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    resolve(value);
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.failPending?.(error);
    this.pending = null;
    this.failPending = null;
  }
}

function reply(socket: Socket, code: number): void {
  if (socket.destroyed) return;
  socket.write(
    Buffer.from([SOCKS_VERSION, code, 0x00, ADDRESS_IPV4, 0, 0, 0, 0, 0, 0]),
  );
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) {
    groups.push(bytes.readUInt16BE(offset).toString(16));
  }
  return groups.join(":");
}

async function readConnectTarget(
  reader: SocketReader,
  socket: Socket,
): Promise<{ host: string; port: number }> {
  const [version, methodCount] = await reader.read(2);
  if (version !== SOCKS_VERSION || !methodCount) {
    throw new SocksReplyError(REPLY_GENERAL_FAILURE, "Unsupported SOCKS version");
  }
  const methods = await reader.read(methodCount);
  if (!methods.includes(NO_AUTHENTICATION)) {
    socket.write(Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_METHODS]));
    throw new SocksReplyError(REPLY_NOT_ALLOWED, "Unsupported SOCKS authentication");
  }
  socket.write(Buffer.from([SOCKS_VERSION, NO_AUTHENTICATION]));

  const [requestVersion, command, , addressType] = await reader.read(4);
  if (requestVersion !== SOCKS_VERSION) {
    throw new SocksReplyError(REPLY_GENERAL_FAILURE, "Unsupported SOCKS version");
  }
  if (command !== CONNECT_COMMAND) {
    throw new SocksReplyError(
      REPLY_COMMAND_NOT_SUPPORTED,
      "Only SOCKS CONNECT is supported",
    );
  }
  let host: string;
  if (addressType === ADDRESS_IPV4) {
    host = [...(await reader.read(4))].join(".");
  } else if (addressType === ADDRESS_IPV6) {
    host = formatIpv6(await reader.read(16));
  } else if (addressType === ADDRESS_DOMAIN) {
    const [length] = await reader.read(1);
    if (!length) {
      throw new SocksReplyError(REPLY_ADDRESS_NOT_SUPPORTED, "Empty SOCKS host");
    }
    host = (await reader.read(length)).toString("utf8");
  } else {
    throw new SocksReplyError(
      REPLY_ADDRESS_NOT_SUPPORTED,
      "Unsupported SOCKS address type",
    );
  }
  const port = (await reader.read(2)).readUInt16BE(0);
  if (port === 0) {
    throw new SocksReplyError(REPLY_NOT_ALLOWED, "SOCKS port 0 is not allowed");
  }
  return { host, port };
}

function connectPinned(
  addresses: ReadonlyArray<{ address: string; family: number }>,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const attempt = () => {
      if (signal.aborted) {
        reject(new Error("SOCKS client disconnected"));
        return;
      }
      const target = addresses[index];
      if (!target) {
        reject(
          new SocksReplyError(REPLY_HOST_UNREACHABLE, "SOCKS target unreachable"),
        );
        return;
      }
      index += 1;
      const upstream = connect({
        family: target.family,
        host: target.address,
        port,
      });
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
        upstream.destroy(new Error("SOCKS connect timed out"));
      });
      const cancel = () => upstream.destroy(new Error("SOCKS client disconnected"));
      signal.addEventListener("abort", cancel, { once: true });
      const tryNextAddress = () => {
        signal.removeEventListener("abort", cancel);
        upstream.destroy();
        attempt();
      };
      upstream.once("error", tryNextAddress);
      upstream.once("connect", () => {
        signal.removeEventListener("abort", cancel);
        upstream.setTimeout(0);
        upstream.off("error", tryNextAddress);
        upstream.on("error", () => upstream.destroy());
        resolve(upstream);
      });
    };
    attempt();
  });
}

export interface EgressProxyOptions {
  /** Permits loopback destinations for local development and tests. */
  allowLocal: boolean;
  name: string;
}

/**
 * Handles one SOCKS5 CONNECT request. The proxy resolves the requested host
 * itself, rejects it unless every address is publicly routable, and connects
 * to the validated address so DNS cannot change between check and use.
 */
async function handleConnection(
  client: Socket,
  options: EgressProxyOptions,
): Promise<void> {
  client.setTimeout(HANDSHAKE_TIMEOUT_MS, () => client.destroy());
  client.on("error", () => client.destroy());
  // Cancel DNS resolution and connection attempts if the client goes away
  // before the tunnel is established.
  const clientClosed = new AbortController();
  client.once("close", () => clientClosed.abort());
  const reader = new SocketReader(client);
  let target: { host: string; port: number } | undefined;
  try {
    target = await readConnectTarget(reader, client);
    const addresses = await resolvePublicHostAddresses(target.host, {
      allowLocal: options.allowLocal,
      signal: AbortSignal.any([
        clientClosed.signal,
        AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      ]),
    }).catch(() => {
      throw new SocksReplyError(
        REPLY_NOT_ALLOWED,
        "SOCKS target is not a public address",
      );
    });
    const upstream = await connectPinned(
      addresses,
      target.port,
      clientClosed.signal,
    );
    if (clientClosed.signal.aborted) {
      upstream.destroy();
      return;
    }
    client.setTimeout(0);
    reply(client, REPLY_SUCCEEDED);
    const early = reader.release();
    if (early.length > 0) upstream.write(early);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  } catch (error) {
    const code =
      error instanceof SocksReplyError ? error.reply : REPLY_GENERAL_FAILURE;
    if (code === REPLY_NOT_ALLOWED && target && !clientClosed.signal.aborted) {
      console.warn(
        JSON.stringify({
          event: "egress_proxy_target_rejected",
          host: isIP(target.host) ? target.host : target.host.slice(0, 253),
          port: target.port,
          proxy: options.name,
        }),
      );
    }
    reply(client, code);
    client.end();
  }
}

export async function startEgressProxy(
  options: EgressProxyOptions,
): Promise<{ close: () => Promise<void>; server: Server; url: string }> {
  const server = createServer((client) => {
    void handleConnection(client, options);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The egress proxy did not bind a TCP port");
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    server,
    url: `socks5h://127.0.0.1:${address.port}`,
  };
}
