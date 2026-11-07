# Signal

Signal is an optional product area behind the organization capability named
`signal`. A workspace with it sees Setup, Findings, and Usage under Signal,
with Settings in a separate Workspace group; Automations and telemetry are not
in its navigation. Direct Signal URLs also require the capability.

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
  month, up to 50 findings) or Max ($200 a month, up to 100). Choosing one
  opens checkout from `/api/signal/billing/checkout`, and Signal turns on when
  checkout returns. With a plan, the step shows the findings used this
  period, switches plans, opens the billing portal, and turns Signal off and
  on. Where the deployment does not bill, it only turns Signal on and off.
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
