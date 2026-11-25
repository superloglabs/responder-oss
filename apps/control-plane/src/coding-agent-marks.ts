// The coding agents Slack buttons can open, as settings show them: the
// workspace's notification buttons and Signal's finding buttons.
export const codingAgentMarks = {
  claude: { name: "Claude Code", logo: "/coding-agents/claude.svg", description: "Opens a new terminal session. Needs Claude Code." },
  codex: { name: "Codex", logo: "/coding-agents/codex.svg", description: "Opens a new thread. Needs the Codex app." },
  conductor: { name: "Conductor", logo: "/coding-agents/conductor.png", description: "Opens a new workspace. Needs the Conductor app on macOS." },
  t3: { name: "T3 Code", logo: "/coding-agents/t3.png", description: "Opens a new thread. Needs the T3 Code app." },
  capy: { name: "Capy", logo: "/coding-agents/capy.svg", description: "Opens a new thread in Capy." },
  cmux: { name: "cmux", logo: "/coding-agents/cmux.png", description: "Pastes the prompt into the focused cmux terminal, after you confirm." },
  replicas: { name: "Replicas", logo: "/coding-agents/replicas.png", description: "Opens a new Replicas workspace with the prompt." },
} as const satisfies Record<string, { name: string; logo: string; description: string }>;
