import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("responder-worker");

// Runs a queue handler in its own trace, so the job's queries, requests, and
// logs are grouped under one span named for the queue.
export function tracedJobHandler<Job extends { data: unknown; id: string }, Result>(
  queue: string,
  handler: (jobs: Job[]) => Promise<Result>,
): (jobs: Job[]) => Promise<Result> {
  return (jobs) =>
    tracer.startActiveSpan(
      `process ${queue}`,
      {
        attributes: {
          "messaging.batch.message_count": jobs.length,
          "messaging.destination.name": queue,
          "messaging.operation.type": "process",
          "messaging.system": "pg-boss",
          ...(jobs.length === 1 && jobs[0] ? { "messaging.message.id": jobs[0].id } : {}),
        },
        kind: SpanKind.CONSUMER,
        root: true,
      },
      async (span) => {
        try {
          return await handler(jobs);
        } catch (error) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : undefined,
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
}
