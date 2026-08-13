import { useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  DataTable,
  EmptyState,
  IconButton,
  Panel,
  Radio,
  SearchField,
  SelectField,
  SegmentedControl,
  Switch,
  Tabs,
  TextAreaField,
  TextField,
} from "../design-system";
import { useDocumentTitle } from "../use-document-title";

const tokenGroups = [
  {
    name: "Surfaces",
    tokens: [
      ["Canvas", "rgb(7 7 7)"],
      ["Card", "rgb(17 17 17)"],
      ["Raised card", "#171717"],
      ["Outline", "rgb(30 30 30)"],
      ["Top outline", "rgb(52 52 52)"],
    ],
  },
  {
    name: "Text",
    tokens: [
      ["Primary", "#efefed"],
      ["Secondary", "#aaa9a5"],
      ["Muted", "#777773"],
      ["Disabled", "#4e4e4a"],
    ],
  },
  {
    name: "Status",
    tokens: [
      ["Positive", "#a6c69b"],
      ["Warning", "#cbb984"],
      ["Danger", "#cf9793"],
      ["Info", "#91afca"],
    ],
  },
];

const agents = [
  { id: "1", name: "Production responder", source: "Datadog", status: "Live", runs: "1,204" },
  { id: "2", name: "Sentry investigator", source: "Sentry", status: "Paused", runs: "836" },
  { id: "3", name: "API monitor", source: "Slack", status: "Live", runs: "312" },
];

type AgentFilter = "all" | "live" | "paused";

const searchItems = [
  { id: "forecast", label: "Forecast summer demand" },
  { id: "suppliers", label: "Find waffle cone suppliers" },
  { id: "flavors", label: "Compare seasonal flavors" },
  { id: "launch", label: "Draft flavor launch plan" },
  { id: "cold-chain", label: "Check cold-chain status" },
  { id: "sugar", label: "Audit sugar costs" },
  { id: "retire", label: "Retire low sellers" },
];

function PlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
      <path d="M3 4.5h12v9H3z" stroke="currentColor" />
      <path d="M3 10h3l1.25 1.5h3.5L12 10h3" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function DesignLibraryPage() {
  useDocumentTitle("Design library");
  const [mode, setMode] = useState<"investigate" | "remediate" | "observe">("investigate");
  const [tab, setTab] = useState<"agents" | "issues" | "settings">("agents");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [notifications, setNotifications] = useState(true);
  const [source, setSource] = useState<"datadog" | "sentry" | "slack">("datadog");
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <main className="designLibraryPage">
      <header className="designLibraryHero">
        <h1>Quiet surfaces. Clear hierarchy.</h1>
        <p>
          A complete interface foundation built on an almost-black canvas,
          tonal cards, and precise one-pixel separation.
        </p>
      </header>

      <nav aria-label="Design library sections" className="designLibraryNav">
        <a href="#foundations">Foundations</a>
        <a href="#actions">Actions</a>
        <a href="#forms">Forms</a>
        <a href="#navigation">Navigation</a>
        <a href="#data">Data</a>
        <a href="#feedback">Feedback</a>
      </nav>

      <section className="designLibrarySection" id="foundations">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Foundations</h2>
            <p>Layered tonal values define the interface depth model.</p>
          </div>
        </div>
        <div className="designLibraryTokenGrid">
          {tokenGroups.map((group) => (
            <Panel key={group.name} padding="compact">
              <h3>{group.name}</h3>
              <div className="designLibrarySwatches">
                {group.tokens.map(([name, value]) => (
                  <div className="designLibrarySwatch" key={name}>
                    <span style={{ background: value }} />
                    <div>
                      <strong>{name}</strong>
                      <code>{value}</code>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
        <Panel className="designLibrarySurfaceStage" padding="spacious" surface="base">
          <div className="designLibrarySurfaceStage__copy">
            <span className="designLibraryComponentLabel">Base card</span>
            <h3>Background layer</h3>
            <p>RGB 17. No visible outline or shadow.</p>
          </div>
          <Panel className="designLibraryRaisedExample" padding="default" surface="raised">
            <span className="designLibraryComponentLabel">Raised card</span>
            <h3>Placed above the base card</h3>
            <p>RGB 30 outline, inset top hairline, and Tailwind shadow-xl.</p>
          </Panel>
        </Panel>
        <CodeBlock code={'<Panel surface="raised" className="shadow-xl" />'} />
      </section>

      <section className="designLibrarySection" id="actions">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Actions and status</h2>
            <p>Primary, secondary, quiet, destructive, loading, and status states.</p>
          </div>
        </div>
        <Panel className="designLibraryShowcase" padding="spacious">
          <div className="designLibraryControlRow">
            <Button variant="primary">Create agent</Button>
            <Button variant="secondary">View details</Button>
            <Button variant="ghost">Dismiss</Button>
            <Button variant="danger">Archive</Button>
            <Button loading variant="secondary">Working</Button>
            <Button disabled variant="secondary">Disabled</Button>
            <IconButton aria-label="Add item"><PlusIcon /></IconButton>
          </div>
          <div className="designLibraryControlRow">
            <Badge>Default</Badge>
            <Badge tone="live">Live</Badge>
            <Badge tone="info">Investigating</Badge>
            <Badge tone="warning">SEV 2</Badge>
            <Badge tone="danger">Failed</Badge>
          </div>
        </Panel>
      </section>

      <section className="designLibrarySection" id="forms">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Forms and selection</h2>
            <p>Text entry, search, selection, validation, and binary choices.</p>
          </div>
        </div>
        <Panel className="designLibraryShowcase" padding="spacious">
          <div className="designLibraryFieldGrid">
            <TextField hint="Use a concise, recognizable name." label="Agent name" placeholder="Production responder" />
            <SelectField
              hint="Controls which alerts can start an investigation."
              label="Input source"
              onChange={setSource}
              options={[
                { description: "Monitor alert events", label: "Datadog", value: "datadog" },
                { description: "Investigate new issues", label: "Sentry", value: "sentry" },
                { description: "Respond when tagged", label: "Slack", value: "slack" },
              ]}
              value={source}
            />
            <TextField error="A repository is required." label="Repository" placeholder="owner/repository" />
          </div>
          <TextAreaField label="Instructions" placeholder="Describe how this agent should investigate…" />
          <div className="designLibrarySearchExample">
            <span className="designLibraryComponentLabel">Command search</span>
            <SearchField
              items={searchItems}
              label="Search flavors"
              onValueChange={setSearchQuery}
              placeholder="Search flavors…"
              value={searchQuery}
            />
          </div>
          <div className="designLibrarySelectionGrid">
            <div className="designLibrarySelectionGroup">
              <span className="designLibraryComponentLabel">Checkboxes</span>
              <Checkbox defaultChecked label="Create pull requests" description="Open a fix when a safe change is available." />
              <Checkbox label="Post summaries" description="Send the result to the output channel." />
            </div>
            <div className="designLibrarySelectionGroup">
              <span className="designLibraryComponentLabel">Radio</span>
              <Radio defaultChecked label="Every issue" name="trigger" />
              <Radio label="Only when tagged" name="trigger" />
            </div>
            <div className="designLibrarySelectionGroup">
              <span className="designLibraryComponentLabel">Switch</span>
              <Switch
                checked={notifications}
                description="Notify the workspace when an investigation finishes."
                label="Completion notifications"
                onCheckedChange={setNotifications}
              />
            </div>
          </div>
        </Panel>
      </section>

      <section className="designLibrarySection" id="navigation">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Navigation</h2>
            <p>Use tabs for destinations and segmented controls for local modes.</p>
          </div>
        </div>
        <Panel className="designLibraryShowcase" padding="spacious">
          <Tabs
            aria-label="Primary product areas"
            onChange={setTab}
            options={[
              { label: "Agents", value: "agents" },
              { label: "Issues", value: "issues" },
              { label: "Settings", value: "settings" },
            ]}
            value={tab}
          />
          <div className="designLibrarySelectionGroup">
            <span className="designLibraryComponentLabel">Local mode</span>
            <SegmentedControl
              aria-label="Investigation mode"
              onChange={setMode}
              options={[
                { label: "Investigate", value: "investigate" },
                { label: "Remediate", value: "remediate" },
                { label: "Observe", value: "observe" },
              ]}
              value={mode}
            />
          </div>
        </Panel>
      </section>

      <section className="designLibrarySection" id="data">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Data display</h2>
            <p>Calm rows, clear alignment, and status that remains easy to scan.</p>
          </div>
        </div>
        <DataTable
            aria-label="Agents"
            activeFilter={agentFilter}
            columns={[
              {
                header: "Agent",
                key: "agent",
                render: (agent) => (
                  <div className="designLibraryIdentity">
                    <Avatar name={agent.name} size="small" />
                    <strong>{agent.name}</strong>
                  </div>
                ),
                width: "42%",
              },
              { header: "Source", key: "source", render: (agent) => agent.source },
              {
                header: "Status",
                key: "status",
                render: (agent) => agent.status === "Live" ? <Badge tone="live">Live</Badge> : <Badge>Paused</Badge>,
              },
              { align: "right", header: "Runs", key: "runs", render: (agent) => agent.runs },
            ]}
            filters={[
              { count: agents.length, label: "All", value: "all" },
              { count: agents.filter((agent) => agent.status === "Live").length, dot: "#25a878", label: "Live", value: "live" },
              { count: agents.filter((agent) => agent.status === "Paused").length, dot: "#f09a2f", label: "Paused", value: "paused" },
            ]}
            getRowKey={(agent) => agent.id}
            onFilterChange={setAgentFilter}
            rows={agents.filter((agent) => agentFilter === "all" || agent.status.toLowerCase() === agentFilter)}
          />
      </section>

      <section className="designLibrarySection" id="feedback">
        <div className="designLibrarySection__heading">
          <div>
            <h2>Feedback and empty states</h2>
            <p>Communicate state with language first, supported by restrained color.</p>
          </div>
        </div>
        <div className="designLibraryFeedbackGrid">
          <Panel className="designLibraryAlertStack" padding="default">
            <Alert title="Changes saved" tone="success">The agent configuration is live.</Alert>
            <Alert title="Integration needs attention" tone="warning">Reconnect Datadog to resume investigations.</Alert>
            <Alert title="Could not create pull request" tone="danger">Check repository access and try again.</Alert>
          </Panel>
          <Panel padding="none">
            <EmptyState
              action={<Button size="small" variant="secondary">Create agent</Button>}
              description="Create an agent to begin investigating production issues."
              icon={<InboxIcon />}
              title="No agents yet"
            />
          </Panel>
        </div>
      </section>
    </main>
  );
}
