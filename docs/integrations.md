# Integration setup

Set `RESPONDER_PUBLIC_URL` to the stable HTTPS origin of your deployment, for
example `https://responder.example`. Replace `<public>` below with that origin.

Provider application credentials belong in the deployment secret environment.
Customer installations and refreshable credentials are tenant-scoped in
Postgres and encrypted before storage. Configure the same base64-encoded
32-byte `CREDENTIAL_ENCRYPTION_KEY` for the control plane and worker.

## Linear

Create a Responder-owned Linear OAuth app with `read` and `write` scopes:

- OAuth callback: `<public>/api/integrations/linear/callback`
- Environment: `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`

Add the connected Linear workspace to an agent's context to let investigations
inspect teams, projects, and existing issues. Agent context uses Linear's
read-only MCP endpoint. The only write path is Responder's controlled
`create_linear_ticket` tool.

When **Create Linear tickets for issues** is enabled, report submission creates
a pending ticket request only for issues first found by that investigation.
Recurrences do not create a request. A separate follow-up lets the agent choose
the Linear team and optional project, creates the ticket, then stores its Linear
ID, identifier, and URL on the Responder issue.

The editable Markdown description template supports `{{issue_id}}`,
`{{issue_url}}`, `{{title}}`, `{{description}}`, `{{severity}}`,
`{{evidence}}`, and `{{remediation}}`. Responder renders the template before
the controlled creation tool writes to Linear.

## Slack

Configure a distributed Slack app with:

- OAuth redirect: `<public>/api/integrations/slack/callback`
- Events request URL: `<public>/api/webhooks/slack`
- Interactivity URL: `<public>/api/webhooks/slack/actions`
- Bot events: `app_mention`, `message.channels`, and `message.groups`
- Bot scopes: `app_mentions:read`, `channels:history`, `channels:join`,
  `channels:read`, `chat:write`, `chat:write.public`, `groups:history`,
  `groups:read`, and `reactions:write`
- User scopes: `channels:history` and `groups:history`
- Environment: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
  `SLACK_SIGNING_SECRET`

Enable Slack's hosted MCP server in the app's agent settings if the app is
eligible to use it. Reconnect existing installations after changing scopes.
Private channels require the bot to be invited.

## Sentry

Create a public Sentry integration with:

- External installation URL:
  `https://sentry.io/sentry-apps/<SENTRY_APP_SLUG>/external-install/`
- Redirect URL: `<public>/api/integrations/sentry/callback`
- Webhook URL: `<public>/api/webhooks/sentry`
- Resource subscriptions: `issue.created` and `issue.unresolved`
- Permissions: Organization read, Project read, and Event read
- Verify install: enabled
- Environment: `SENTRY_APP_SLUG`, `SENTRY_CLIENT_ID`, and
  `SENTRY_CLIENT_SECRET`

Responder validates `Sentry-Hook-Signature`, synchronizes visible projects,
and triggers only agents whose installation and project match.

## GitHub

Configure a public GitHub App with:

- Installation target: any account
- Request user authorization during installation: enabled
- Callback and setup URL: `<public>/api/integrations/github/callback`
- Repository permissions: Contents read/write, Pull requests read/write, and
  Metadata read
- Account permission: Email addresses read-only
- Webhook URL: `<public>/api/webhooks/github`
- Subscribe to: Pull request
- Environment: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
  `GITHUB_WEBHOOK_SECRET`

The private key never enters the investigation sandbox. Responder creates a
short-lived installation token and materializes only selected repositories.

## Datadog

Connect Datadog from Settings and choose the matching Datadog site. Alerts can
arrive through a watched Slack channel, while investigations use Datadog's MCP
endpoint for the connected site.

## ClickStack

ClickStack Cloud uses `https://mcp.clickhouse.cloud/clickstack` with OAuth and
the service ID from its generated MCP configuration.

For self-hosted ClickStack, enter a public HTTPS MCP URL and a Personal API
Access Key. Responder verifies the key against the team API and stores it in the
encrypted tenant credential envelope. Loopback HTTP is accepted only during
local development.

## Vercel

Create a Vercel Integration with:

- External installation URL initiated by Responder:
  `https://vercel.com/integrations/<VERCEL_INTEGRATION_SLUG>/new`
- Redirect URL: `<public>/api/integrations/vercel/callback`
- Read access for Projects, Deployments, Deployment Checks, Domains, Teams,
  Logs, Security, and any other non-secret platform areas the investigation
  agent should inspect
- No write access and no environment-variable, token, secret, credential, or
  API-key scopes
- Environment: `VERCEL_INTEGRATION_SLUG`, `VERCEL_CLIENT_ID`, and
  `VERCEL_CLIENT_SECRET`

Responder encrypts each installation token, synchronizes only the projects
visible to that installation, and keeps the token in the worker process. The
investigation sandbox receives two host-side tools: one searches a generated
catalog of safe Vercel GET operations, and one executes a selected operation.
Regenerate the catalog from Vercel's published OpenAPI document after API
updates with `pnpm vercel:generate-api`.

## Custom MCP servers

Organizations can connect remote Streamable HTTP MCP servers with either a
bearer token or OAuth 2.0. The OAuth callback is:

```text
<public>/api/integrations/custom_mcp/callback
```

OAuth servers must support authorization-server discovery, PKCE, dynamic client
registration, and that redirect URL. Non-local servers must use HTTPS and
resolve only to public network addresses.

## Local callbacks

Provider consoles generally require public HTTPS callbacks. Put a stable ngrok
origin in the gitignored `.env.tunnel.local` file of your main checkout:

```dotenv
RESPONDER_NGROK_URL=https://responder-dev.ngrok-free.dev
```

Start the complete stack, then explicitly route the shared tunnel to this
worktree:

```bash
pnpm local:dev
pnpm tunnel:claim
pnpm tunnel:status
```

Use the tunnel origin for the provider URLs above. A tunnel claim is
machine-global and last-claim-wins. Release it when finished:

```bash
pnpm tunnel:release
```
