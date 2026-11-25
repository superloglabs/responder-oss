import { useState, type KeyboardEvent, type PointerEvent } from "react";
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
// An agent turned on is moved by dragging its handle, with a mouse, a
// finger, or a pen, or with the arrow keys on the handle.
export function CodingAgentRows({ value, onChange }: {
  value: SignalCodingAgents;
  onChange: (next: SignalCodingAgents) => void;
}) {
  // The order while a handle is dragged; it is saved when the drag ends.
  const [dragOrder, setDragOrder] = useState<SignalCodingAgent[] | null>(null);
  const [dragged, setDragged] = useState<SignalCodingAgent | null>(null);
  const shown = dragOrder ?? value.agents;

  function toggle(agent: SignalCodingAgent, on: boolean) {
    const agents = on ? [...value.agents, agent] : value.agents.filter((candidate) => candidate !== agent);
    onChange({ ...value, agents });
  }

  function save(agents: SignalCodingAgent[]) {
    if (agents.some((agent, index) => agent !== value.agents[index])) onChange({ ...value, agents });
  }

  function key(event: KeyboardEvent, index: number) {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
    if (to === null) return;
    event.preventDefault();
    save(moveAgent(value.agents, index, to));
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, agent: SignalCodingAgent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragged(agent);
    setDragOrder(value.agents);
  }

  // Moves the dragged agent to the row under the pointer.
  function drag(event: PointerEvent<HTMLButtonElement>) {
    const agent = dragged;
    if (!agent || !dragOrder) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-agent]");
    const to = dragOrder.indexOf(row?.dataset.agent as SignalCodingAgent);
    const from = dragOrder.indexOf(agent);
    if (to >= 0 && to !== from) setDragOrder(moveAgent(dragOrder, from, to));
  }

  function endDrag() {
    if (dragOrder) save(dragOrder);
    setDragged(null);
    setDragOrder(null);
  }

  return <ul className="signalAgents" aria-label="Coding agents">
    {agentRows({ ...value, agents: shown }).map(({ agent, on }) => {
      const details = agentDetails[agent];
      const index = shown.indexOf(agent);
      return <li key={agent} data-agent={agent}
        className={`signalAgent${dragged === agent ? " signalAgent--dragging" : ""}`}>
        <span className="signalAgent__handle">
          {on && <button type="button" aria-label={`Move ${details.name}. Use the up and down arrow keys.`}
            onKeyDown={(event) => key(event, index)}
            onPointerDown={(event) => startDrag(event, agent)}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}>
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
