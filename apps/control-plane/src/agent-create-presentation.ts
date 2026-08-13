export type ContextConnectionStatus =
  | "available"
  | "connected"
  | "not_connected";

export function slackContextConnectionStatus(input: {
  available: boolean;
  selectedChannelCount: number;
}): ContextConnectionStatus {
  if (!input.available) return "not_connected";
  return input.selectedChannelCount > 0 ? "connected" : "available";
}
