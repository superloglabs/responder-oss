import { createHash } from "node:crypto";
import { createServer } from "node:net";
import process from "node:process";

const firstBasePort = 12_000;
const availableBlocks = 10_000;

function configuredBasePort() {
  if (!process.env.CONDUCTOR_PORT) return null;

  const port = Number(process.env.CONDUCTOR_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_532) {
    throw new Error(`Invalid CONDUCTOR_PORT: ${process.env.CONDUCTOR_PORT}`);
  }
  return port;
}

function pathSeed(path) {
  const digest = createHash("sha256").update(path).digest();
  return digest.readUInt32BE(0) % availableBlocks;
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function blockIsAvailable(basePort) {
  const availability = await Promise.all(
    [0, 1, 2, 3].map((offset) => portIsAvailable(basePort + offset)),
  );
  return availability.every(Boolean);
}

const configured = configuredBasePort();
if (configured) {
  process.stdout.write(`${configured}\n`);
} else {
  const workspace = process.argv[2] ?? process.cwd();
  const seed = pathSeed(workspace);
  let selected = null;

  for (let attempt = 0; attempt < availableBlocks; attempt += 1) {
    const slot = (seed + attempt) % availableBlocks;
    const candidate = firstBasePort + slot * 4;
    if (await blockIsAvailable(candidate)) {
      selected = candidate;
      break;
    }
  }

  if (!selected) throw new Error("Unable to find four available local ports.");
  process.stdout.write(`${selected}\n`);
}
