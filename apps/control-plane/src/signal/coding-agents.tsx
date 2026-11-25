import { useState, type DragEvent, type KeyboardEvent } from "react";
import { IconCheck, IconGripVertical, IconSend } from "@tabler/icons-react";
import { codingAgentMarks } from "../coding-agent-marks";
import { Button, Switch } from "../design-system";
import { agentRows, moveAgent, type TestState } from "./coding-agents-model";
import {
  type SignalClaudeSurface,
  type SignalCodingAgent,
  type SignalCodingAgents,
} from "./model";

const agentDetails: Record<SignalCodingAgent, { name: string; logo: string; description: string }> = codingAgentMarks;

const claudeDescriptions: Record<SignalClaudeSurface, string> = {
  terminal: "Opens a new terminal session. Needs Claude Code.",
  desktop: "Opens a new session in the Claude desktop app.",
  web: "Opens a new session in Claude Code on the web.",
};

// The coding agents a finding's Slack message opens in. Each button fills
// in a prompt about the finding; nothing runs until the person sends it.
export function CodingAgentRows({ value, onChange }: {
  value: SignalCodingAgents;
  onChange: (next: SignalCodingAgents) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);

  function toggle(agent: SignalCodingAgent, on: boolean) {
    const agents = on ? [...value.agents, agent] : value.agents.filter((candidate) => candidate !== agent);
    onChange({ ...value, agents });
  }

  function move(from: number, to: number) {
    const agents = moveAgent(value.agents, from, to);
    if (agents.some((agent, index) => agent !== value.agents[index])) onChange({ ...value, agents });
  }

  function drop(event: DragEvent, to: number) {
    event.preventDefault();
    if (dragging !== null) move(dragging, to);
    setDragging(null);
  }

  function key(event: KeyboardEvent, index: number) {
    if (event.key === "ArrowUp") { event.preventDefault(); move(index, index - 1); }
    if (event.key === "ArrowDown") { event.preventDefault(); move(index, index + 1); }
  }

  return <ul className="signalAgents" aria-label="Coding agents">
    {agentRows(value).map(({ agent, on }) => {
      const details = agentDetails[agent];
      const index = value.agents.indexOf(agent);
      return <li key={agent} className={`signalAgent${dragging === index && on ? " signalAgent--dragging" : ""}`}
        draggable={on}
        onDragStart={() => setDragging(index)}
        onDragEnd={() => setDragging(null)}
        onDragOver={(event) => { if (on && dragging !== null) event.preventDefault(); }}
        onDrop={(event) => drop(event, index)}>
        <span className="signalAgent__handle">
          {on && <button type="button" aria-label={`Move ${details.name}. Use the up and down arrow keys.`} onKeyDown={(event) => key(event, index)}>
            <IconGripVertical size={14} />
          </button>}
        </span>
        <img className="signalAgent__logo" src={details.logo} alt="" />
        <span className="signalSettingsRow__label">
          <strong>{details.name}</strong>
          <span>{agent === "claude" ? claudeDescriptions[value.claudeSurface] : details.description}</span>
        </span>
        {agent === "claude" && <select className="signalSettingsSelect signalAgent__surface" aria-label="Claude Code app"
          value={value.claudeSurface}
          onChange={(event) => onChange({ ...value, claudeSurface: event.target.value as SignalClaudeSurface })}>
          <option value="terminal">Terminal</option>
          <option value="desktop">Desktop app</option>
          <option value="web">Web</option>
        </select>}
        <Switch className="signalSwitch" aria-label={`Open in ${details.name}`} checked={on}
          label={on ? "On" : "Off"} onCheckedChange={(checked) => toggle(agent, checked)} />
      </li>;
    })}
  </ul>;
}

export function TestMessageButton({ disabled, saving, test, send }: {
  disabled: boolean;
  // Settings are saving, so the test waits for them.
  saving: boolean;
  test: TestState;
  send: () => void;
}) {
  return <Button disabled={disabled || saving || test.state === "sending"} loading={test.state === "sending"} onClick={send}
    title={disabled ? "Choose a Slack channel for findings first." : undefined}>
    <IconSend size={14} />Send test message
  </Button>;
}

export function TestMessageResult({ test }: { test: TestState }) {
  if (test.state === "sent") {
    return <p className="signalTestResult" role="status"><IconCheck size={14} />
      Test message sent to the findings channel with these buttons. Its buttons open a sample prompt.</p>;
  }
  if (test.state === "error") return <p className="signalTestResult signalTestResult--error" role="alert">{test.message}</p>;
  return null;
}
