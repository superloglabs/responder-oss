// Builds the Daytona snapshot that sandboxes start from, then prints the value
// for DAYTONA_SANDBOX_SNAPSHOT_NAME. Uses DAYTONA_API_KEY, and DAYTONA_API_URL
// and DAYTONA_TARGET when set. Does nothing when the snapshot already exists.
import { Daytona, Image } from "@daytonaio/sdk";
import { isDaytonaNotFound, requireDaytonaClientConfig } from "@responder/core/daytona-config";
import {
  sandboxSnapshotBaseImage,
  sandboxSnapshotCommands,
  sandboxSnapshotName,
} from "./sandbox-snapshot.js";

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
    { entrypoint: ["sleep", "infinity"], image, name },
    { onLogs: (chunk) => process.stdout.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`) },
  );
  console.log(`Built snapshot ${name}.`);
}
console.log(`DAYTONA_SANDBOX_SNAPSHOT_NAME=${name}`);
