# Signal

Signal is an optional product area behind the organization capability named
`signal`. A workspace with it sees Setup, Findings, and Usage under Signal,
with Settings in a separate Workspace group; Automations and telemetry are not
in its navigation. Direct Signal URLs also require the capability.

A Signal workspace receives OpenTelemetry data without the `telemetry`
capability: it creates ingest keys, lists the services sending data, reads its
logs, traces, and metrics through the API and MCP, and has its errors grouped
into issues, which Signal reads. Those issues send no notifications, wake no
agents, and start no automations. Signal setup reads `GET
/api/telemetry/services`; the other `/api/telemetry/*` routes, the AWS, Google
Cloud, and Vercel telemetry sources, error issue pages, dashboards, alerts,
and error notifications still need `telemetry`.

For a newly created local workspace, set
`RESPONDER_NEW_ORGANIZATION_CAPABILITIES=signal` before creating it.

The pages read and write `/api/signal/*`, which a deployment serves through its
extension service (`RESPONDER_EXTENSION_*`, see `.env.example`). Without one,
those requests fail and the pages show their errors.

- **Setup** shows the workspace's real connections. Providers with their own
  connection dialog open it here; OAuth providers return to the same step.
  Google Cloud and OpenTelemetry link to their settings pages. Repositories and
  the findings channel come from the workspace's GitHub and Slack connections
  and are saved to Signal's settings. The last step is the plan: Pro ($100 a
  month, up to 50 findings) or Max ($200 a month, up to 100). A Slack channel
  must be chosen first. Choosing a plan opens checkout from
  `/api/signal/billing/checkout`. When checkout returns, the step waits up to
  10 seconds for the plan to be recorded and turns Signal on the first time;
  if the plan is not recorded by then, Signal stays off and the step says the
  payment is still being confirmed. With a plan, the step shows the findings
  used this period, switches plans without turning Signal on, opens the
  billing portal, and turns Signal off and on. A workspace with findings
  granted without a plan, or a deployment that does not bill, turns Signal on
  and off directly. Signal can always be turned off, also after its plan
  ended.
- **Findings** lists posted findings by day, with search, a 7, 14, or 30 day
  range, and paging. A finding shows its impact, root cause, suggested fix,
  and evidence. Copy prompt accepts it; Mark as irrelevant and Restore change
  its status.
- **Usage** charts posted and accepted findings per day.

Until setup is complete, the workspace sees only Setup and Settings, and
Findings and Usage open setup. If the settings lookup fails, the sidebar shows
every item and each page shows its own error. Setup is complete once Signal has been turned
on, even if it is turned off later. `/app` opens findings after that, and
setup until then.

## Verification

`pnpm exec playwright test signal.spec.ts` runs the pages against a fake
Signal API: capability-off access, setup with real connection data and the
saved settings, choosing a plan and returning from checkout, the current
plan and its used findings, opening findings once on, search, ranges, paging, prompt copy
and status changes with the requests they send, usage periods, keyboard account
navigation, and mobile layout.
