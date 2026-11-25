import { useState } from "react";
import { sendSignalTestMessage, signalCodingAgents, type SignalCodingAgent, type SignalCodingAgents } from "./model";

// Agents turned on first, in their saved order, then the rest.
export function agentRows(value: SignalCodingAgents) {
  return [
    ...value.agents.map((agent) => ({ agent, on: true })),
    ...signalCodingAgents.filter((agent) => !value.agents.includes(agent)).map((agent) => ({ agent, on: false })),
  ];
}

// Moves the agent at `from` to `to` among the agents turned on.
export function moveAgent(agents: readonly SignalCodingAgent[], from: number, to: number): SignalCodingAgent[] {
  if (from === to || from < 0 || to < 0 || from >= agents.length || to >= agents.length) return [...agents];
  const next = [...agents];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export type TestState = { state: "idle" } | { state: "sending" } | { state: "sent" } | { state: "error"; message: string };

// Posts a message with the buttons findings get, so the team can try them.
export function useTestMessage() {
  const [test, setTest] = useState<TestState>({ state: "idle" });
  async function send() {
    setTest({ state: "sending" });
    try {
      await sendSignalTestMessage();
      setTest({ state: "sent" });
    } catch (failure) {
      setTest({ state: "error", message: failure instanceof Error ? failure.message : "Could not send the test message." });
    }
  }
  return { test, send };
}
