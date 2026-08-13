import {
  createJobBoss,
  prepareWorkerQueues,
  workerHealthQueue,
} from "@responder/core/jobs";

const secretsFile = process.env.RESPONDER_SECRETS_FILE;
if (secretsFile) process.loadEnvFile(secretsFile);

const marker = process.env.WORKER_HEALTH_MARKER;
if (!marker) throw new Error("WORKER_HEALTH_MARKER is required");

const boss = createJobBoss();

try {
  await boss.start();
  await prepareWorkerQueues(boss);
  const jobId = await boss.send(workerHealthQueue, {
    marker,
    requestedAt: new Date().toISOString(),
  });

  if (!jobId) throw new Error("Unable to create worker health job");
  console.log(JSON.stringify({ event: "worker_health_job_sent", jobId, marker }));
} finally {
  await boss.stop({ graceful: true, timeout: 10_000 });
}
