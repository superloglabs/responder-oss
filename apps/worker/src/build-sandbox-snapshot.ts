// Builds the snapshot that sandboxes start from for the configured provider.
//
// For Daytona, prints the value for DAYTONA_SANDBOX_SNAPSHOT_NAME. Uses
// DAYTONA_API_KEY, and DAYTONA_API_URL and DAYTONA_TARGET when set. Does nothing
// when the snapshot already exists.
//
// For Vercel, prints the value for VERCEL_SANDBOX_SNAPSHOT_ID. Uses
// VERCEL_PROJECT_ID, VERCEL_SANDBOX_REGION, VERCEL_TEAM_ID and VERCEL_TOKEN.
// Snapshots stay in their region and never expire, so run this once per cell.
import { Daytona, Image } from "@daytonaio/sdk";
import { isDaytonaNotFound, requireDaytonaClientConfig } from "@responder/core/daytona-config";
import { sandboxProvider } from "@responder/core/sandbox-config";
import { buildVercelSandboxSnapshot } from "./build-vercel-sandbox-snapshot.js";
import {
  sandboxSnapshotBaseImage,
  sandboxSnapshotCommands,
  sandboxSnapshotName,
  sandboxSnapshotResources,
} from "./sandbox-snapshot.js";

async function buildDaytonaSandboxSnapshot(): Promise<void> {
  const config = requireDaytonaClientConfig();
  const daytona = new Daytona({
    apiKey: config.daytonaApiKey,
    apiUrl: config.daytonaApiUrl,
    target: config.daytonaTarget,
  });
  const name = sandboxSnapshotName();

  let exists = false;
  try {
    const snapshot = await daytona.snapshot.get(name);
    exists = true;
    console.log(`Snapshot ${name} already exists (${snapshot.state}).`);
  } catch (error) {
    if (!isDaytonaNotFound(error)) throw error;
  }

  if (!exists) {
    const image = Image.base(sandboxSnapshotBaseImage).runCommands(...sandboxSnapshotCommands());
    await daytona.snapshot.create(
      { entrypoint: ["sleep", "infinity"], image, name, resources: sandboxSnapshotResources },
      { onLogs: (chunk) => process.stdout.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`) },
    );
    console.log(`Built snapshot ${name}.`);
  }
  console.log(`DAYTONA_SANDBOX_SNAPSHOT_NAME=${name}`);
}

// Ends on its own rather than through process.exit, so piped output is flushed.
if (sandboxProvider() === "vercel") {
  console.log(`VERCEL_SANDBOX_SNAPSHOT_ID=${await buildVercelSandboxSnapshot()}`);
} else {
  await buildDaytonaSandboxSnapshot();
}
