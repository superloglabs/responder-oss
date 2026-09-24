// Installs the pinned grafana/mcp-grafana release used by the worker for
// self-hosted Grafana context. Production images install the same version in
// apps/worker/Dockerfile; keep the version and checksums in sync.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MCP_GRAFANA_VERSION = "1.5.1";

const releaseAssets = {
  "darwin-arm64": {
    name: "mcp-grafana_Darwin_arm64.tar.gz",
    sha256: "d0f7e159680a8698f9475c7ec8a06cb65d9a10462f80165d1927e7d5a4975e21",
  },
  "darwin-x64": {
    name: "mcp-grafana_Darwin_x86_64.tar.gz",
    sha256: "7cbcf7302c55fff87da53488492d967badeb1587f0ff576bf3da417f9eab8c18",
  },
  "linux-arm64": {
    name: "mcp-grafana_Linux_arm64.tar.gz",
    sha256: "6ae7bd9d89879f9332b76ba95865bed1aa59e89ce2a30f9bbb91d67e8dfb6b57",
  },
  "linux-x64": {
    name: "mcp-grafana_Linux_x86_64.tar.gz",
    sha256: "3ef1c7a66aab3ba149de53681d72ea58244baa41331eb3aed9cdd2f68acc0db7",
  },
};

const binaryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".tools",
  `mcp-grafana-${MCP_GRAFANA_VERSION}`,
  "mcp-grafana",
);

async function install() {
  if (existsSync(binaryPath)) {
    process.stdout.write(`${binaryPath}\n`);
    return;
  }

  const asset = releaseAssets[`${process.platform}-${process.arch}`];
  if (!asset) {
    throw new Error(
      `mcp-grafana ${MCP_GRAFANA_VERSION} has no pinned build for ${process.platform}-${process.arch}`,
    );
  }
  const response = await fetch(
    `https://github.com/grafana/mcp-grafana/releases/download/v${MCP_GRAFANA_VERSION}/${asset.name}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error(`Unable to download mcp-grafana (${response.status})`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`mcp-grafana checksum mismatch for ${asset.name}`);
  }

  const workDirectory = mkdtempSync(join(tmpdir(), "mcp-grafana-"));
  try {
    const archivePath = join(workDirectory, asset.name);
    writeFileSync(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "-C", workDirectory, "mcp-grafana"]);
    mkdirSync(dirname(binaryPath), { recursive: true });
    // Copy next to the destination first so an interrupted install never
    // leaves a partial binary at the final path.
    const stagedPath = `${binaryPath}.${process.pid}`;
    copyFileSync(join(workDirectory, "mcp-grafana"), stagedPath);
    chmodSync(stagedPath, 0o755);
    renameSync(stagedPath, binaryPath);
  } finally {
    rmSync(workDirectory, { force: true, recursive: true });
  }
  process.stdout.write(`${binaryPath}\n`);
}

await install();
