# Signal UI preview

Signal is an optional, UI-only product area. Enable the existing organization
capability named `signal` for a test workspace, then open `/signal/setup`.
It is disabled by default. Direct Signal URLs also require the capability.

For a newly created local workspace, set
`RESPONDER_NEW_ORGANIZATION_CAPABILITIES=signal` before creating it.
This setting does not modify existing workspaces. Hosted operators can use the
Signal capability switch in the private admin's organization table.

Signal takes precedence in the sidebar: Setup, Findings, Usage, and Settings.
Automations and telemetry are not displayed for these workspaces. Existing
server authorization for other product areas remains unchanged; this UI flag
does not grant API access.

## Included

- Five-step setup, with a separate GitHub repository-selection view.
- Brand-colour provider logos, including Sentry.
- Simulated connect/manage/disconnect controls and channel/repository selection.
- Pro and Max plan previews; no card capture or checkout.
- Searchable, paginated findings with details, evidence, irrelevant/restore
  actions, and copy-prompt.
- Daily stacked bars and a whole-period bar using the application accent.
- A sidebar-matched account menu, including keyboard navigation.

All findings are fixtures dated October–November 2026. Changing the period
filters those fixtures. Setup selections and status changes are kept in memory
while navigating within Signal and reset on reload or leaving Signal.
The preview makes no integration, ticket, Slack, or payment writes.
Account/workspace actions continue to use the existing application behavior.

## Verification

`pnpm exec playwright test signal.spec.ts` covers capability-off direct access,
the complete setup flow without writes, filtering/pagination, copy and restore,
usage periods, keyboard account navigation, and mobile layout.

