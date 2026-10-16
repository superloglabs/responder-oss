import { OpenTelemetry } from "@ai-sdk/otel";

const integration = new OpenTelemetry();

// GenAI spans for one AI SDK call, so its model and tokens show in
// Responder's own AI telemetry. Prompts and outputs are not recorded. Calls
// opt in one by one, so a new call is not traced with its prompt by default.
export function modelCallTelemetry(functionId: string) {
  return {
    functionId,
    integrations: integration,
    isEnabled: true,
    recordInputs: false,
    recordOutputs: false,
  };
}
