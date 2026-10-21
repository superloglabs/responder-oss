# Integration setup

Set `RESPONDER_PUBLIC_URL` to the stable HTTPS origin of your deployment, for
example `https://responder.example`. Replace `<public>` below with that origin.

Provider application credentials belong in the deployment secret environment.
Customer installations and refreshable credentials are tenant-scoped in
Postgres and encrypted before storage. Configure the same base64-encoded
32-byte `CREDENTIAL_ENCRYPTION_KEY` for the control plane and worker.

## Connect from MCP or the management API

Use `list_available_integrations` to discover configured providers, then
`start_integration_connection` with the selected `provider`. The REST equivalents
are `GET /api/v1/integrations/available` and `POST /api/v1/integrations/connect`.

Slack, GitHub, Sentry, Discord (only in workspaces with the `automations` capability),
Vercel, Linear, Google Cloud, Axiom, PostHog, and Cloudflare normally return a provider consent
URL. Sentry may recover an existing installation and return `connected` without
another consent prompt. The person opens the consent link, approves access, and
returns to chat. The browser must be signed into the same Superlog user and
workspace that authorized the MCP client; callback identity checks are unchanged.
Links expire after ten minutes, and requesting a new link invalidates the previous
flow for that user, workspace, and provider. Do not log or share the URLs.

After consent, call `list_integrations` to verify the connected account and select
resources. Use `refresh_integrations` to reload Slack channels or GitHub
repositories when needed. Google Cloud may also need project selection and setup
in the provider callback flow. A returned URL is not proof of a connection.

Providers with additional configuration or credential entry return
`connectionType: secure_setup` and a setup link instead of a consent URL. Never
collect their API keys or other secrets in the conversation. Provider application
credentials remain server configuration, not tool arguments.

## Linear

Create a Responder-owned Linear OAuth app. Responder requests the `read`,
`write`, `app:mentionable`, and `app:assignable` scopes:

- OAuth callback: `<public>/api/integrations/linear/callback`
- Webhooks: enabled, with URL `<public>/api/webhooks/linear` and the
  **Agent session events** category
- Environment: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and
  `LINEAR_WEBHOOK_SECRET`, the app's webhook signing secret
- Optional: `LINEAR_ISSUE_LABEL`, the label added to every issue Responder
  creates. It defaults to `Responder`.

Responder authorizes the app with `actor=app`, so Linear shows the app, not the
person who connected it, as the creator of each issue. Settings asks
connections made before this change to reconnect. Every created issue also
carries the workspace label from `LINEAR_ISSUE_LABEL`. Responder creates the
label on first use. If Linear refuses the label, the issue is still created
without it.

People can mention Responder in a Linear issue or comment, or delegate an
issue to it. Linear opens an agent session, and Responder runs the request as
a tag mode turn with tag mode's model, instructions, repositories, and
integrations. With simplified navigation, it works as an assistant that can
open pull requests and change the workspace; otherwise it investigates.
Responder posts progress, the reply, and any failure to the session. Replies in
the session continue the same turn history and sandbox. Tag mode must be on;
otherwise the session shows an error. Connections made before mentions existed
must reconnect to grant the app scopes. When one Linear workspace is connected
to several Responder workspaces, the most recent connection answers. Responder
verifies `Linear-Signature` and rejects deliveries signed more than a minute
earlier.

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

Automations can add a Linear connection as a connector. The automation context
broker serves one MCP server for it: Linear's read-only tools (issues,
projects, teams, users, labels, and workflow states) and a `create_issue`
tool. `create_issue` takes the team, title, and Markdown description, and
optionally an assignee, labels, priority, project, workflow state, and parent
issue. The broker makes the write itself, records it as an action of the run,
and uses the action attempt ID as the Linear issue ID, so a retry does not
create a second issue. The agent picks the assignee itself, for example by
reading a commit's author through `github_api` and matching them to a Linear
user.

## Slack

Configure a distributed Slack app with:

- OAuth redirect: `<public>/api/integrations/slack/callback`
- Events request URL: `<public>/api/webhooks/slack`
- Interactivity URL: `<public>/api/webhooks/slack/actions`
- Bot events: `app_home_opened`, `app_mention`, `message.channels`,
  `message.groups`, and `message.im`
- Bot scopes: `app_mentions:read`, `channels:history`, `channels:join`,
  `channels:read`, `chat:write`, `chat:write.public`, `groups:history`,
  `groups:read`, `im:history`, and `reactions:write`
- User scope: `search:read`
- App Home: turn on the **Messages Tab** and allow users to send messages
  from it
- Environment: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
  `SLACK_SIGNING_SECRET`

Connecting Slack turns tag mode on with its starting settings, unless the
workspace has already saved tag mode settings.

A mention in a thread reads the thread's earlier messages with the bot token,
so a request such as "look at this" refers to the alert above it. The turn
gets at most 50 of those messages and 30,000 characters: the thread's first
message and the newest replies, with a note of how many were left out. A later
mention in the same thread reads only the messages posted since the last turn
that read the thread, minus the replies tag mode posted itself. When Slack
refuses the read or takes longer than 15 seconds, the turn answers from the
mention alone, and the next mention reads those messages again.

A direct message to the app works like a mention. Tag mode answers in the
message's thread, and a reply in that thread continues the same conversation.
A new message starts a new conversation. When tag mode is off, the app replies
that an admin has to turn it on. The first time a person opens the app's
Messages tab, the app sends them a welcome message once.

Responder searches Slack on demand through Slack's `search.messages` Web API
method with the connecting user's token. Search accepts Slack's search syntax,
such as `from:`, `after:`, `has:`, and quoted phrases, except `in:`: Responder
sets the channel constraint itself, so Slack searches, counts, and pages only
allowed channels and never the connecting user's direct messages; any result
from another channel is also dropped. An investigation searches one of its
selected channels per call. An automation with Slack as context can search up
to 50 of its channels in one call, or every channel when it has 50 or fewer,
page through results, and sort by time or relevance. Each result includes text
from message attachments, where alert bots put their content, and the thread it
belongs to. Identical investigation searches share one in-memory request and
result within an investigation; message content is not cached across
investigations. Reconnect existing installations after changing scopes. The connecting user must be able to search each selected channel, and
private channels also require the bot to be invited.

A Slack connection that only triggers an automation gives its runs the
thread that started the run: they can read it, reply in it, and react to the
message that started the run and the thread's first message. Add the same
connection as a connector to give runs search, channel history, and posting in
its channels. The same applies to other triggers: a Sentry connection gives
Sentry tools only when it is also a connector.

A person's reply in a run's thread continues the run only when it mentions the
app. A reply that does not mention the app is left to the people in the thread,
unless it is also sent to the channel: then it is a new message and can start a
run of its own.

An automation's agent can add up to five buttons to a Slack message it posts,
through `post_notification` or `slack_post_message`. Each button carries the
run ID, and the run's action attempt for the message records the button labels
and the Slack connection that posted it. A press reaches the interactivity URL,
which accepts it only when that run posted the message through a connection to
the same Slack workspace. The press is stored as a message on the run, which
then starts its next turn and answers in the message's thread. The first press
on a message is the choice: the buttons are replaced with who pressed which
one, and later presses are refused. Anyone who can see the message can press
a button. A paused run's sandbox is deleted after 24 hours, so a later press
continues the conversation in a new sandbox, where the agent repeats any
changes it had not pushed.

Watched channels accept app-authored CloudWatch alarm notifications from AWS
and Amazon Q Developer in chat applications. Responder starts investigations
only for `ALARM` notifications, normalizes the alarm name, region, state, and
CloudWatch link when present, and ignores `OK` and `INSUFFICIENT_DATA`
notifications. Add the matching AWS account as Agent context so the worker can
inspect the exact alarm, metric history, affected resource, and related logs.

## Discord

Create a Discord application with a bot and enable **Requires OAuth2 Code Grant**.
Configure:

- OAuth redirect: `<public>/api/integrations/discord/callback`
- Interactions endpoint: `<public>/api/webhooks/discord`
- Installation scopes: `identify`, `applications.commands`, and `bot`
- Bot permission: View Channels
- Environment: `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`,
  `DISCORD_CLIENT_SECRET`, and `DISCORD_PUBLIC_KEY`

Connecting Discord installs the application into one server, synchronizes its
text and announcement channels, and registers a guild-scoped `/automate`
command. Automations can watch selected channels. Invoking `/automate` starts
every matching enabled automation, with the optional `context` argument added
to the trigger payload. Interaction signatures are verified before the guild
and channel are matched, and retries are deduplicated by interaction ID.

## DevRev

DevRev is an automation trigger, available in workspaces with the `automations`
capability. Connect it from Settings or from a DevRev trigger card with a
personal access token from a DevRev admin. Responder reads the organization with
`dev-orgs.get`, stores the token encrypted, and registers a `work_created`
webhook for the connection:

```text
<public>/api/webhooks/devrev/<connection>
```

The endpoint answers DevRev's verify challenge, then checks each event's
`X-DevRev-Signature`, the HMAC-SHA256 of the raw body under the secret DevRev
returned for the webhook. Only new tickets start runs; other work items are
ignored. Each ticket starts each matching automation once, so redelivered
events do not start a second run. Reconnecting the same DevRev organization
registers a new webhook and tries to delete the old one. If that fails, the
old webhook keeps sending events, which are refused because their signature
no longer matches; delete it in DevRev.

When a run's first turn ends, Responder posts its final reply, or the failure,
as an internal comment on the ticket, so the customer does not see it. Comments
are posted as the person who created the token. A comment that cannot be posted
is recorded as a `devrev_comment_failed` run event. Follow-up turns continue on
the run page.

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

An automation's Sentry trigger can leave out environments. The webhook
payload has no environment, so Responder reads it from the issue's first event
for a new issue and from its latest event for a regression, after replying to
Sentry. An issue whose environment every matching trigger leaves out does not
start a run. When the environment cannot be read, the run starts. Sentry sends
`issue.created` once per issue, so an issue first seen in a left-out
environment does not start a run when it later reaches another environment.

## GitHub

Configure a public GitHub App with:

- Installation target: any account
- Request user authorization during installation: enabled
- OAuth redirect URI: `<public>/api/integrations/github/callback`
- Setup URL: leave unset
- Repository-access updates can return to the OAuth redirect URI with
  `setup_action=update` and no OAuth code. Responder preserves the installation
  and completes an explicit OAuth authorization before synchronizing it.
- Repository permissions: Contents read/write, Pull requests read/write,
  Metadata read, and read-only Actions, Checks, Commit statuses, and Issues.
  Automation agents read pull request CI state and issues on private
  repositories, and public user profiles, through the worker's `github_api`
  tool.
- Account permission: Email addresses read-only
- Webhook URL: `<public>/api/webhooks/github`
- Subscribe to: Pull request and Pull request review
- Environment: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
  `GITHUB_WEBHOOK_SECRET`

The private key never enters the investigation sandbox. Responder creates a
short-lived installation token and materializes only selected repositories.
A review on a pull request that a tag mode thread or an automation run opened
continues that thread or run. GitHub sends one `pull_request_review` event per
review. Responder reads the review's inline comments and passes the review and
its comments to the thread or run as one message, on the pull request's latest
commit. Comments that do not fit in the message are left out, and the message
says how many. The agent checks each comment, pushes fixes with `update_pull_request`,
and answers each comment with `reply_to_pull_request_comment`. A tag mode
thread answers in its Slack thread or Linear session; an automation run shows
the turn on its run page.

- Reviews from bots, and from people GitHub lists as the repository's owner, a
  member of its organization, or a collaborator, start a turn. Other people's
  reviews and the app's own replies are ignored.
- Bot reviews start at most five turns per pull request, so a reviewer that
  comments on every commit cannot keep the agent pushing.
- Pushes are fast-forward only, so commits pushed by someone else are never
  overwritten.
- Starting a review turn replaces the repository's checkout with the pull
  request's latest commit. Earlier changes in that checkout are saved as a
  patch file beside it.
- Pull requests from remediation and suggestion jobs are not continued.

### Pull request author

By default the GitHub App opens pull requests, so GitHub shows its bot account
as their author. Review bots such as CodeRabbit and Greptile bill per pull
request author, and some charge extra for a bot author. A member can choose
**Use my account** under **Settings → Workspace → Pull requests** to have
Responder open the workspace's pull requests from their GitHub account
instead. GitHub then shows the member as the author, opened through the app.

- The member authorizes the GitHub App on GitHub. Responder keeps the
  resulting user access token encrypted, with its refresh token, and
  refreshes it before it expires. Enable **Expire user authorization tokens**
  on the GitHub App so the token can be refreshed; a token that does not
  expire also works.
- The member's GitHub account must reach one of the workspace's GitHub App
  installations. A user token can only do what both the member and the app
  may do.
- Before opening a pull request, the worker checks that the member can push
  to the repository. Otherwise, or when the token cannot be loaded, the
  GitHub App opens it as before. When GitHub rejects the token, the setting
  shows **Reconnect** and the app opens pull requests until a member
  connects again.
- Only opening the pull request and its first commit use the member's
  account. Later pushes and review replies come from the app, so the app's
  replies are still ignored as reviews.
- The setting stops applying when the member leaves the workspace. The member
  or a workspace admin can switch back to the app with **Use the app**.

### Pull request triggers

In workspaces with the `automations` capability, a GitHub trigger starts a run
when a pull request is opened, merged, or both, in the repositories the trigger
selects. The trigger uses the same `pull_request` webhook and needs no other
subscription.

- A draft counts as opened when it is marked ready for review. A pull request
  starts each automation at most once per event, even when GitHub delivers the
  event again or the pull request goes back to draft.
- On a public repository, a pull request starts a run only if GitHub lists
  its author as the repository's owner, a member of its organization, or a
  collaborator. This applies to merged pull requests too.
- Pull requests the app opens do not start a run when opened, so an
  automation that opens pull requests cannot start itself. Their merges do
  start runs. Without `GITHUB_APP_SLUG`, opened pull requests do not start
  runs, because the app's own cannot be told apart. A pull request Responder
  opens from a member's account is recognized by its branch, which Responder
  records before creating it.
- The agent is told to treat the pull request's title, body, diff, and
  comments as untrusted data.
- The run's trigger payload is the pull request as it was when the event
  arrived. The agent's `github_api` tool can read the pull request's
  repository even when the automation does not check it out. The run cannot
  change that repository unless the automation checks it out.
- Runs report to the automation's Slack notification channels, like scheduled
  and Sentry runs.

## Datadog

Connect Datadog from Settings and choose the matching Datadog site. Alerts can
arrive through a watched Slack channel, while investigations use Datadog's MCP
endpoint for the connected site.

## Dash0

Connect Dash0 from Settings with the organization MCP endpoint shown under
**Organization settings → Endpoints → MCP**. Responder dynamically registers an
OAuth client, redirects the member through Dash0 consent, and refreshes the
short-lived organization-scoped tokens outside the investigation sandbox. The
OAuth callback is:

```text
<public>/api/integrations/dash0/callback
```

No deployment-level Dash0 client ID, secret, or static auth token is required.
Each Dash0 organization is a separate integration account. The worker exposes
only MCP tools explicitly annotated as read-only and blocks Agent0 delegation
tools, so investigations query Dash0 telemetry directly without consuming
Agent0 investigation credits.

After OAuth completes, copy the generated webhook URL and Authorization header
from Responder into a Dash0 **Webhook** notification channel under
**Organization settings → Notification Channels**. Assign that channel directly
to check rules or route alerts to it by labels. Responder authenticates the
channel with a per-connection bearer secret and starts agents configured for
that Dash0 account only when it receives `alert.ongoing`; resolved, superseded,
and closed notifications are acknowledged without starting investigations.

## PostHog

Connect PostHog from Settings. Responder dynamically registers an OAuth client
against PostHog's hosted MCP endpoint and refreshes the project-scoped tokens
outside the investigation sandbox. The OAuth callback is:

```text
<public>/api/integrations/posthog/callback
```

No deployment-level PostHog client ID, API key, or static token is required.
The MCP connection is forced into read-only tools mode and limited to alerts,
dashboards, error tracking, events, insights, logs, replay, replay vision, SQL,
tracing, and web analytics. The worker also rejects any tool that is not
explicitly annotated read-only.

Configure the PostHog alerts Responder should investigate with a **Slack**
notification destination that points to a watched channel. Responder recognizes
messages from the PostHog Slack app, queues the channel's configured agent, and
marks the Slack input as PostHog-originated. Resolved, recovered, auto-disabled, and
errored lifecycle messages are acknowledged without starting investigations.
The connected PostHog project remains read-only investigation context; alert
delivery does not require a second public webhook or shared secret.

## Grafana

Connect Grafana from Settings or the automation editor and choose the
deployment. Grafana is context for investigations and automations; alerts still
arrive through a watched Slack channel or another trigger.

**Grafana Cloud** uses Grafana's hosted MCP server. Enter the stack URL, for
example `https://acme.grafana.net`. Responder derives the stack-scoped endpoint
`https://mcp.grafana.com/mcp/<stack>.grafana.net`, dynamically registers an
OAuth client, and requests only the `grafana:read` and `grafana:query` scopes.
Each stack is a separate integration account. The OAuth callback is:

```text
<public>/api/integrations/grafana/callback
```

No deployment-level Grafana client ID, secret, or API key is required.

**Self-hosted Grafana** uses the open source
[`mcp-grafana`](https://github.com/grafana/mcp-grafana) server, which the worker
runs as a child process. Create a service account with the Viewer role, add a
token, and enter it with the Grafana URL. Responder verifies the token against
`/api/org` and stores it in the encrypted tenant credential envelope. The URL
must use public HTTPS; loopback HTTP is accepted only during local development.

The worker starts `mcp-grafana` with write tools disabled and only the search,
datasource, Prometheus, Loki, Tempo, Pyroscope, Elasticsearch, Graphite,
CloudWatch, alerting, dashboard, folder, annotation, incident, OnCall, Asserts,
Sift, navigation, and query-example categories. Raw API, SQL, rendering,
snapshot, plugin, admin, and provisioning tools stay off. The child process
reaches Grafana through a worker-local SOCKS5 proxy that rejects private,
link-local, and loopback addresses in production. Local development also
permits loopback hosts. The token never enters the repository investigation
sandbox.

In both modes the worker exposes only tools annotated read-only.

Automations can use a Grafana connection as context. The worker gives each run
one server per Grafana connection, served by the run-scoped context broker at
`/api/automation-context-broker/v1/<connection>`. For Grafana Cloud the broker
refreshes the OAuth token, lists tools itself, and forwards calls only to tools
annotated read-only. For self-hosted Grafana the broker starts the same
`mcp-grafana` process, with the same categories and egress proxy, for each tool
call and for listings it has not cached in the last ten minutes, so the service
account token stays in the control plane.

The worker and control plane images install a pinned `mcp-grafana` release and
set `MCP_GRAFANA_BINARY`. Local development downloads the same release into
`.tools/` on the first `pnpm local:dev` or `pnpm dev:worker` start.

## Cloudflare

Cloudflare is read-only context for investigations, tag mode, and automations:
Workers logs and analytics, deployments, and account and zone configuration.
Connect it from Settings or the automation editor. Responder uses Cloudflare's
hosted API MCP server at `https://mcp.cloudflare.com/mcp`, dynamically registers
an OAuth client, and requests only the identity and refresh scopes. Cloudflare's
consent screen then preselects its **Read only** permissions. The OAuth callback
is:

```text
<public>/api/integrations/cloudflare/callback
```

No deployment-level Cloudflare client ID, secret, or API token is required.

The server's `execute` tool runs JavaScript that can call any Cloudflare API
endpoint, so the granted scopes are the read-only boundary. Responder accepts
only scopes that read (`read`, `metadata_read`, `monitoring`, and `report`
scopes, plus `offline_access`). It refuses a grant with any other scope when
connecting, and checks the grant again after every token refresh. If the
person picks other permissions on the consent screen, the connection fails and
asks them to choose read-only permissions.

Each connection belongs to the Cloudflare user who authorized it, so
reconnecting the same user updates that connection. Responder stores the
accounts the user could reach when connecting and passes their names and IDs to
the agent, which passes `account_id` to `execute`. The worker and the context
broker expose only `search`, `execute`, `docs`, and `whoami`. The OAuth tokens
stay outside the investigation sandbox.

Automations reach Cloudflare through the run-scoped context broker at
`/api/automation-context-broker/v1/<connection>`. The broker refreshes the
OAuth token, checks the grant, lists tools itself, and forwards calls only to
the same four tools.

Cloudflare is context only. Runs start from another trigger, such as a watched
Slack channel or a schedule.

## Axiom

Connect Axiom from Settings through the hosted MCP server's browser OAuth flow.
Responder stores the OAuth session encrypted, refreshes it outside the sandbox,
and gives runs Axiom tools by run type. Automations and tag mode may call every
Axiom tool, including writes and deletes for datasets, dashboards, monitors,
and notifiers. Alert investigations and scans get only an allowlist of
read-only query, dataset, metrics, dashboard, monitor, notifier, and service
map tools.

Agents use Axiom as investigation context. Use a watched Slack channel as the
agent input, then add Axiom under Context so the investigation can query
relevant logs, traces, metrics, dashboards, and monitor history.

Automations can use Axiom both ways. As a connector, the run reaches Axiom
through the run-scoped context broker, which refreshes the OAuth session and
forwards every tool listing and call. As a trigger, an Axiom monitor alert
starts the automation. Each Axiom connection has its own webhook:

```text
<public>/api/webhooks/axiom/<connection>
```

The trigger card's **Set up Axiom notifier** shows the URL, an `Authorization`
header value, and a body template to paste into an Axiom **Custom webhook**
notifier. Add that notifier to the monitors that should start runs. The header
secret is derived per connection from `CREDENTIAL_ENCRYPTION_KEY`, so it
survives OAuth refreshes; reconnecting Axiom as a new connection, or rotating
that key, changes it. Responder starts a run for `Open` alerts and ignores
`Closed` ones. A retried delivery with the same body does not start a second
run. Axiom-triggered automations report to their notification channels.

The hosted Axiom MCP endpoint routes query results through US infrastructure.
Review Axiom's data-routing and query-cost controls before enabling it for
sensitive or high-volume datasets.

## SigNoz

SigNoz is an automation trigger and connector, available in workspaces with
the `automations` capability. Connect it from Settings or the automation
editor with a SigNoz Cloud instance URL, such as
`https://acme.us.signoz.cloud`, and a service account API key. In SigNoz, open
**Settings → Service Accounts**, create a service account, and add an API key.
The Viewer role lets runs read telemetry; Editor also lets them change alerts
and dashboards. Responder verifies the key against
`/api/v1/service_accounts/me` on the instance and stores it in the encrypted
tenant credential envelope. Each instance is a separate integration account.
Only SigNoz Cloud hosts of the form `<tenant>.<region>.signoz.cloud` are
accepted.

As a connector, the run reaches SigNoz through the run-scoped context broker,
which forwards tool listings and calls to the region's hosted MCP server,
`https://mcp.<region>.signoz.cloud/mcp`, with the `SIGNOZ-API-KEY` and
`X-SigNoz-URL` headers. The key never enters the sandbox. The service account
role limits what the tools can do.

As a trigger, a SigNoz alert starts the automation. Each SigNoz connection has
its own webhook:

```text
<public>/api/webhooks/signoz/<connection>
```

The trigger card's **Set up SigNoz channel** shows the URL and a token. In
SigNoz, open **Settings → Alert Channels**, create a **Webhook** channel with
that URL, leave **Username** empty, and paste the token as the **Password**.
SigNoz then sends it as a bearer token. Select the channel in the alert rules
that should start runs. The token is derived per connection from
`CREDENTIAL_ENCRYPTION_KEY`; reconnecting the same instance keeps it, and
rotating that key changes it.

SigNoz sends Alertmanager's webhook body, which can hold several alerts.
Responder starts one run per firing alert, at most 20 per delivery, and
ignores resolved alerts. Alertmanager repeats firing alerts until they
resolve; an alert's fingerprint and start time identify it, so a repeat does
not start a second run. SigNoz-triggered automations report to their
notification channels.

## Honeycomb

Honeycomb is an automation trigger and connector, available in workspaces
with the `automations` capability. Connect it from Settings or the automation
editor with the team's region (US or EU) and a management API key. In
Honeycomb, a team owner opens **Team Settings → API Keys → Management Keys**
and creates a key with read access to **Model Context Protocol** and
**Environments**. Responder verifies the key and its scopes against `/2/auth`
on the region's API and stores the key ID and secret in the encrypted tenant
credential envelope. Each team is a separate integration account.

As a connector, the run reaches Honeycomb through the run-scoped context
broker, which forwards tool listings and calls to the region's hosted MCP
server, `https://mcp.honeycomb.io/mcp` or `https://mcp.eu1.honeycomb.io/mcp`,
with `Authorization: Bearer <key ID>:<secret>`. The key never enters the
sandbox. The key's scopes limit what the tools can do.

As a trigger, a Honeycomb trigger or SLO burn alert starts the automation.
Each Honeycomb connection has its own webhook:

```text
<public>/api/webhooks/honeycomb/<connection>
```

The trigger card's **Set up Honeycomb webhook** shows the URL and a shared
secret. In Honeycomb, open **Team Settings → Integrations**, add a **Webhook**
with that URL and secret, and keep the default payload. Add the webhook as a
recipient on the triggers and burn alerts that should start runs. Honeycomb
sends the secret in `X-Honeycomb-Webhook-Token`. The secret is derived per
connection from `CREDENTIAL_ENCRYPTION_KEY`; reconnecting the same team keeps
it, and rotating that key changes it.

Responder starts a run for each `TRIGGERED` notification and ignores `OK`
(resolved) notifications and Honeycomb's test notifications. A retry carries
the same `X-Honeycomb-Webhook-Delivery-ID`, so it does not start a second run.
A trigger set to alert on every evaluation, rather than on change, sends a
new delivery each time it is evaluated, and each one starts a run.
Honeycomb-triggered automations report to their notification channels.

## Upstash

Connect Upstash from Settings with the Upstash account email and a developer
API key. Upstash's developer API authenticates with both values, so the email
is required even though the API key is the secret. Create a dedicated key for
Responder and rotate or revoke it from the Upstash console when needed. No
deployment-level Upstash environment variables are required.

Responder encrypts the account credentials in the tenant credential envelope.
During an investigation, the worker combines two read-only context layers:

- fixed Upstash CLI commands list and inspect Redis, Vector, Search, QStash,
  and team resources;
- a filtered Upstash MCP process provides Redis inspection plus QStash and
  Workflow logs, schedules, and dead-letter queues.

The worker accepts no arbitrary CLI arguments, removes mutation tools, validates
Redis commands against a read-only allowlist, and redacts credential-shaped
fields from provider output. Upstash credentials stay in the worker process and
never enter the repository investigation sandbox.

## Langfuse

Connect Langfuse from Settings with a project public key and secret key. Choose
the matching Langfuse Cloud region or enter the origin of a self-hosted Langfuse
v4 deployment. Each key pair belongs to one Langfuse project, and an agent may
select more than one connected project. No deployment-level Langfuse environment
variables are required.

Langfuse currently authenticates its Public API and MCP server with project API
keys rather than delegated OAuth. Responder verifies the project identity and
required observation tools before encrypting the key pair in the tenant
credential envelope.

During an investigation, the worker connects to Langfuse's Streamable HTTP MCP
endpoint and exposes a fixed read-only allowlist for observations, scores,
metrics, prompts, and alerts. New upstream tools are unavailable until reviewed.
Responder bounds unscoped observation searches to the latest 24 hours, limits
result sizes and concurrency, redacts credential-shaped output, and keeps the
project keys outside the repository investigation sandbox.

## Supabase

Connect Supabase from Settings by choosing an access level and continuing to
Supabase OAuth. The user authorizes an organization, then Responder discovers
its projects through the hosted MCP server. A sole project is selected
automatically; otherwise the user chooses from a project picker. The hosted MCP
server dynamically registers the OAuth client, so no project ID,
deployment-level Supabase client ID, secret, service-role key, or database
password is required. The OAuth callback is:

```text
<public>/api/integrations/supabase/callback
```

Each project and access-level combination is stored as a separate integration
account. Agents can select one or more of these connections:

- **Logs only** enables the debugging feature and exposes the reviewed Supabase
  log retrieval and query tools available on the hosted server.
- **Logs and read-only data** also enables database tools with Supabase's
  `read_only=true` boundary, exposing SQL queries and schema inspection.
- **Full database SQL access** exposes the same reviewed database tools without
  the read-only parameter, so `execute_sql` can change project data or schema.

Project discovery uses a temporary `features=account&read_only=true` MCP scope
and calls only `list_projects`. Project choices and OAuth credentials remain in
a tenant-bound, ten-minute server-side state while the picker is open. Responder
then constructs the project-scoped hosted MCP URL from the authorized project
and access level; it never accepts that URL from the browser. The worker applies
a second exact tool allowlist and blocks the dedicated migration, Edge Function
deployment, branching, project administration, and every unreviewed tool in all
modes. Because raw SQL can still perform DDL in the full-access preset, blocking
the dedicated migration tool is not a schema-change boundary. OAuth tokens
remain encrypted outside the repository investigation sandbox.

For read-only data access, Supabase's handling of the MCP `read_only` parameter
is the database mutation boundary: Responder cannot independently determine
whether arbitrary SQL is read-only. Treat full database SQL access as production
write access and grant it only to agents whose investigation workflow needs it.
Supabase recommends using its MCP server with development or test projects; if
you connect production, prefer logs-only or read-only access.

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
- No write access except to Drains, which telemetry sources use, and no
  environment-variable, token, secret, credential, or API-key scopes
- Environment: `VERCEL_INTEGRATION_SLUG`, `VERCEL_CLIENT_ID`, and
  `VERCEL_CLIENT_SECRET`

Responder encrypts each installation token, synchronizes only the projects
visible to that installation, and keeps the token in the worker process. The
investigation sandbox receives two host-side tools: one searches a generated
catalog of safe Vercel GET operations, and one executes a selected operation.
The callback verifies the installation identity, team, and selected-project
set without narrowing the integration's configured read permissions.
Listings that can filter by project must name a shared project, project and
team listings return only the installation's projects and team, and listings
that span the team's projects without a project filter are not offered.
Regenerate the catalog from Vercel's published OpenAPI document after API
updates with `pnpm vercel:generate-api`.

Automations can use a Vercel connection as context. Connect it from Settings or
the automation editor. The run-scoped context broker at
`/api/automation-context-broker/v1/<connection>` serves the same two tools as
one MCP server per connection, so the installation token stays in the control
plane. A run reaches every project the installation shares with Responder.

## AWS

AWS is optional read-only context for investigations and automations. A
workspace owner enters the 12-digit AWS account ID, reviews the generated
CloudFormation stack, and verifies the connection after the stack reaches
`CREATE_COMPLETE`.

The stack creates a fixed `ResponderInvestigationRole` protected by the
deployment broker ARN and a unique external ID. It attaches AWS-managed
`AIOpsAssistantPolicy`, which applies account-wide and does not restrict
regions. An explicit deny prevents the role from retrieving Secrets Manager
values, SSM parameters, or decrypting KMS ciphertext. Responder obtains and
automatically refreshes temporary credentials through STS; it never asks for or
stores customer access keys. The managed AWS MCP client exposes tools explicitly
annotated read-only, plus AWS's sandboxed script runner and task polling tools.
The role's read-only policy and explicit secret-value denies remain the
authorization boundary for script-runner API calls. This integration currently
supports the commercial AWS partition (`arn:aws`) only.

AWS context does not receive native EventBridge or SNS webhooks. CloudWatch
alarms can trigger an Agent when Amazon Q Developer in chat applications
forwards the alarm to a watched Slack channel; the selected AWS account remains
the read-only investigation context. AWS alarm investigations preload the
CloudWatch, messaging, and serverless investigation guides. Typed read-only
tools cover CloudWatch alarm configuration and history, metrics, Logs Insights,
SQS queue attributes, and Lambda configuration and event source mappings. The
managed sandboxed script runner remains available for other read-only AWS API
calls.

Automations can use an AWS connection as context. The worker gives each run
one server per AWS account, served by the run-scoped context broker at
`/api/automation-context-broker/v1/<connection>`. The broker assumes the same
customer role as investigations, signs each request to the managed AWS MCP
server, lists tools itself, and exposes and accepts calls only to the tools
investigations allow. The typed CloudWatch, SQS, and Lambda tools and the alarm
guides are investigation-only.

Production deployments should store the generic template in a private S3
bucket and configure `AWS_INTEGRATION_TEMPLATE_BUCKET` and
`AWS_INTEGRATION_TEMPLATE_KEY`, plus the bucket's region in
`AWS_INTEGRATION_TEMPLATE_REGION`. The control plane generates a short-lived
presigned S3 URL for CloudFormation Quick Create. Without those values, the UI
offers a pre-filled template as a file download for manual upload.

Self-hosted deployments must also set `AWS_INTEGRATION_PRINCIPAL_ARN` to a
stable broker role that the runtime can assume. The broker must allow
`sts:AssumeRole` only on customer roles named `ResponderInvestigationRole`.

## Google Cloud

Google Cloud is optional read-only context for investigations. A workspace
owner selects **Connect** and signs in with Google. Responder lists the projects
that account can see, and the owner chooses one. The OAuth callback is:

```text
<public>/api/integrations/gcp/callback
```

The Google sign-in requests the Cloud Platform scope with online access only.
Responder uses that token to set up the project, then revokes it. It does not
store a refresh token. While setup runs, the token is kept encrypted in the
setup job.

Each project is a separate integration account. Setup first checks that the
signed-in account can enable services, create service accounts and identity
pools, and change project IAM. It then enables the IAM, Security Token Service,
Service Account Credentials, Cloud Asset Inventory, Logging, and Monitoring
APIs. It creates a fixed `responder-investigation` service account and a
customer-owned Workload Identity Federation pool/provider that trusts the
configured Responder AWS broker. The service-account binding is restricted to
one encrypted, randomly generated broker session name. It grants only MCP Tool
User, Cloud Asset Viewer, Logs Viewer, Monitoring Viewer, and Service Usage
Consumer. Setup runs as a background worker job, one bounded round at a time,
until Google finishes each step and Responder can use the new identity. The
connection dialog and the Google Cloud tile in Settings show its progress, so
closing the browser does not stop it. Setup gives up after 15 minutes.

During an investigation, Responder assumes the broker with that connection's
stable session name, exchanges the AWS identity for a short-lived Google token,
and impersonates the customer service account. It never asks for or stores a
service-account key. Google Cloud Asset Inventory, Logging, and Monitoring run
through Google's managed remote MCP servers. Responder exposes only tools that
the servers explicitly annotate read-only; the customer IAM roles remain the
authorization boundary.

Automations can use a Google Cloud connection as context. The worker gives
each run one server per Google service, served by the run-scoped context
broker at `/api/automation-context-broker/v1/<connection>/<service>` (`assets`,
`logging`, or `monitoring`). The broker gets federated Google credentials the
same way investigations do, lists tools itself, and exposes and accepts calls
only to tools that Google annotates read-only.

This integration requires `AWS_INTEGRATION_PRINCIPAL_ARN`, the same stable
broker role used by AWS context, plus a Google OAuth web client in
`GCP_OAUTH_CLIENT_ID` and `GCP_OAUTH_CLIENT_SECRET`. The client's Google Cloud
project must enable the Cloud Resource Manager, Service Usage, and IAM APIs,
because Google charges the quota for setup requests made with user tokens to
that project. Self-hosted deployments must run on AWS with
permission to assume that role. Native Google Cloud alert ingestion is a
separate integration boundary.

## Telemetry sources

Workspaces with the telemetry capability open **Add telemetry** from the
telemetry Overview page to send logs, traces and metrics. Every option needs a cell with a collector
(`TELEMETRY_COLLECTOR_URL`).

- **OpenTelemetry**: create an ingest key and paste the generated prompt into a
  coding agent. The prompt asks it to add the OpenTelemetry SDK, export all
  three signals over OTLP/HTTP to `<public>/api/ingest`, and connect the app's
  logger.
- **AWS**: choose a region and deploy the generated CloudFormation stack. It
  creates a CloudWatch metric stream in the OpenTelemetry 1.0 format and an
  account-level CloudWatch Logs subscription, each delivered by its own
  Firehose stream to `<cell>/api/ingest/aws/firehose/metrics` and `/logs`.
  Firehose sends a new ingest key as its access key. Records Firehose cannot
  deliver go to a bucket in the customer's account for seven days. One stack
  covers one region; an account allows one account-level subscription policy
  per region. Quick Create needs the template in the template bucket under
  `AWS_TELEMETRY_TEMPLATE_KEY`; without it the page offers the template for
  download and an AWS CLI command.
- **Google Cloud**: choose a connected project. The worker reads Cloud Logging
  every minute and a fixed set of Cloud Monitoring metrics every five minutes
  with the connection's keyless identity, which already has Logs Viewer and
  Monitoring Viewer. Reads stop one minute (logs) and five minutes (metrics)
  behind the present, so late entries outside that window are not read. A
  source that falls more than an hour behind skips ahead. Data Access audit
  logs are skipped.
- **Vercel**: choose a connected installation. Responder creates a trace drain
  that sends OTLP to `<cell>/api/ingest/v1/traces` and a log drain that sends
  NDJSON to `<cell>/api/ingest/vercel/logs`, both for the projects the
  installation shares. Drains need a Pro or Enterprise team, and the Vercel
  Integration needs read and write access to **Drains**. Existing
  installations must accept the new permission before drains can be created.

Removing a source revokes its ingest key. Responder also removes Vercel
drains; an AWS stack stays until the customer deletes it.

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

Start the complete stack. Startup waits for the dashboard to become healthy,
then automatically routes the shared tunnel to this worktree:

```bash
pnpm local:dev
pnpm tunnel:status
```

Use the tunnel origin for the provider URLs above. A tunnel claim is
machine-global and last-start-wins. Stopping the development command releases
its claim unless another worktree has claimed the tunnel in the meantime. The
manual claim and release commands remain available when changing the selected
worktree without restarting it:

```bash
pnpm tunnel:claim
pnpm tunnel:release
```

The connection tool also supplies an inline connection card. It opens a signed handoff to provider consent, checks `list_integrations`, and requests a continuation only after the provider appears connected. Hosts that support conversation return addresses pass one to the handoff; successful consent then returns to that conversation. Other hosts show a focused completion page. Automatic continuation requires an active card and host support; plain MCP clients can check `list_integrations` on the next turn. Return addresses are restricted to supported chat origins and bound to the requesting user, workspace, and expiring connection ticket.
