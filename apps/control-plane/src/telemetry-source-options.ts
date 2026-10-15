// The ways a workspace can send telemetry, in the order Add telemetry lists
// them. The cloud providers need no code changes.
export const telemetrySourceOptions = [
  {
    description: "Send logs, traces and metrics from your code with the OpenTelemetry SDK. A prompt for your coding agent sets it up.",
    id: "opentelemetry",
    title: "OpenTelemetry",
  },
  {
    description: "Stream CloudWatch metrics and logs through Firehose from one CloudFormation stack per region.",
    id: "aws",
    title: "Amazon Web Services",
  },
  {
    description: "Read Cloud Logging and Cloud Monitoring from a connected Google Cloud project.",
    id: "gcp",
    title: "Google Cloud",
  },
  {
    description: "Create drains that stream the traces and logs of your Vercel deployments.",
    id: "vercel",
    title: "Vercel",
  },
] as const;

export type TelemetrySourceOptionId = (typeof telemetrySourceOptions)[number]["id"];

export function telemetrySourceOption(id: string | undefined) {
  return telemetrySourceOptions.find((option) => option.id === id);
}
