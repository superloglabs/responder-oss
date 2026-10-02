# Architecture

Responder separates interactive control-plane work from background agent work.
Both services share a Postgres database.

```text
Browser / providers
        │ HTTPS
        ▼
  static web + control-plane API
        │
        ├── authentication and tenant configuration
        ├── encrypted integration credentials
        └── durable investigation jobs ───────────┐
                                                  ▼
                                               worker
                                         ┌────────┼────────┐
                                         ▼        ▼        ▼
                                      sandbox   model   providers
```

## Components

The control plane owns the React UI, authentication, workspace membership,
integration setup, public webhooks, and tenant-facing APIs. It validates and
normalizes provider events before enqueueing work.

The worker claims durable jobs from Postgres, resolves the investigation's
pinned agent and runtime versions, creates an isolated repository workspace,
runs the investigation, and persists the resulting trace and report.

`packages/core` is the shared boundary. It owns the schema, tenant-aware data
access, credential encryption, provider clients, queue contracts, and report
types. `drizzle/` contains the ordered schema history.

## Security boundaries

- Every agent, integration, resource, investigation, issue, and job belongs to
  an organization. Database queries and API routes enforce that ownership.
- Provider credentials are encrypted before storage with
  `CREDENTIAL_ENCRYPTION_KEY`. Only the control plane and worker should receive
  that key.
- Slack, GitHub, and Sentry webhook signatures are checked against the untouched
  request body. Dash0 webhooks require a random per-connection bearer secret.
  Retries are deduplicated with provider-specific keys.
- App-authored CloudWatch `ALARM` notifications in watched Slack channels use
  the existing Slack trigger. The control plane normalizes available alarm
  identity and location fields, ignores recovery states, and the worker uses
  only AWS accounts selected on the pinned Agent version as read-only context.
- Google Cloud context uses customer-owned Workload Identity Federation and a
  dedicated service account. A unique AWS broker session is the federated
  principal, so Responder exchanges short-lived credentials without creating
  or storing service-account keys. The worker exposes only managed Cloud Asset
  Inventory, Logging, and Monitoring tools annotated read-only.
- Remote MCP destinations must use HTTPS and resolve to public addresses.
  Redirects are revalidated and authorization is not forwarded across origins.
- Dash0 uses dynamic OAuth client registration with encrypted, refreshable,
  organization-scoped tokens. Its MCP endpoint is restricted to Dash0 hosts;
  only tools annotated read-only are exposed and Agent0 delegation is blocked.
- PostHog uses dynamic OAuth client registration against its hosted MCP endpoint.
  The endpoint is fixed to read-only tools and a bounded set of observability and
  analytics features, and the worker additionally requires the MCP read-only annotation.
  PostHog alerts enter through watched Slack channels rather than a second webhook path.
- Grafana Cloud uses dynamic OAuth client registration against Grafana's hosted
  MCP endpoint for one stack and requests only the read and query scopes.
  Self-hosted Grafana runs the pinned `mcp-grafana` binary in the worker with a
  service account token, write tools disabled, and a fixed category list. Its
  outbound traffic goes through a worker-local SOCKS5 proxy. In production the
  proxy connects only to public addresses; local development also permits
  loopback hosts. Both modes expose only tools annotated read-only.
- Linear context uses its read-only MCP endpoint. Ticket creation goes through
  a separate controlled tool that records a stable request before writing and
  stores the resulting Linear identifier and link. Automations reach Linear
  through the context broker, which lists the read-only tools and adds its own
  `create_issue` tool that records each write as a run action.
- Langfuse context uses encrypted project-scoped API keys outside the sandbox.
- A context server that cannot be reached does not fail the investigation.
  Its tools are replaced by a single reconnect tool that shows the connection
  error, and the agent decides whether to retry. Each server's read-only tool
  filter still applies to the tools it exposes after reconnecting. The agent
  and the worker logs receive the provider's error with the investigation's
  connection credentials redacted.
- Supabase context uses encrypted OAuth sessions and a temporary read-only
  account scope to discover projects after authorization. Responder then pins
  agent access to the selected project and permission preset with
  server-generated hosted MCP parameters and an exact worker-side tool
  allowlist. Logs-only and read-only presets prevent database writes; read-only
  SQL additionally relies on Supabase enforcing its `read_only` boundary. The
  full SQL preset permits necessary data and schema changes while Supabase
  administration and platform-configuration tools remain blocked.
- Repository work runs in a separate sandbox. GitHub credentials stay outside
  the sandbox; the service streams selected repository snapshots through
  bounded worker scratch storage and into the isolated workspace without
  buffering the complete archive in worker memory.
- Pull-request review follow-ups accept only new top-level bot comments on PRs
  created by Responder. Comment text is untrusted input, human comments are
  ignored, and the controlled publisher can only fast-forward the existing PR
  branch, reply to the supplied thread IDs, and resolve those threads.
- Tenant trace responses omit the initial composed runtime instructions. The
  raw stored trace retains them for an operator's private diagnostics.
- The management API (`/api/v1`) and MCP server (`/api/mcp`) accept only
  workspace API keys sent as bearer tokens; session cookies do not
  authenticate them. Only a SHA-256 digest of each key is stored. A key acts
  as the member who created it, so changes record that member, and the key
  stops working when they leave the workspace or the key is revoked.
  Responses are parsed with their documented schemas, so undocumented fields
  are dropped. Operations that take a secret value, such as storing a
  workspace secret or a model API key, are not offered as MCP tools.

## Management API and MCP server

`apps/control-plane/server/management/operations.ts` defines each management
operation once: its path, input and output schemas, and handler. The REST
routes under `/api/v1`, the stateless Streamable HTTP MCP server at `/api/mcp`,
and the OpenAPI document at `/api/v1/openapi.json` are generated from those
definitions. `pnpm api:openapi <file>` writes the document for the hosted
docs. Members create and revoke keys under Settings → API keys.

## Versioning and jobs

Agent configuration and runtime profiles are immutable versions. An
investigation pins both versions when it is created, so later configuration
changes cannot alter a queued or replayed run.

A workspace member can rerun a finished investigation from its detail page.
The rerun reuses the original provider input but replaces the investigation's
report and trace with a run against the Agent's active configuration, the active
runtime profile, current provider data, and current repository heads. Previous
issue records remain available after their investigation links are replaced.
Reruns consume the normal investigation allowance and use normal delivery and
external-action behavior.

## Usage metering

Autumn holds a monthly dollar allowance per organization. Automations always
draw on it; organizations with simplified navigation also pay for
investigations, pull request reviews, and remediations from it instead of
spending investigation credits.

- Responder-funded model requests are reserved before they run and recorded
  after. Investigation and pull request review runs record their model usage
  when they finish.
- The worker records each period a sandbox runs, from start or resume until it
  is paused or deleted, and renews the period every minute. A period whose
  worker exited is closed at its last heartbeat.
- `packages/core/src/billing/usage-pricing.ts` turns provider cost and sandbox
  time into the charged amount. The default charges model usage at cost and
  does not charge for sandbox time. A hosted edition may replace the file.
- Work checks the allowance before it starts. Work already running finishes and
  is charged even if it goes past the allowance. Operator replays are not
  charged.
- The billing page splits the period's charges into model usage and sandbox
  time from these rows. Autumn's balance remains the total.
- Usage rows are reported with their row ID as the idempotency key. Rows that
  fail are retried for up to a day.

Postgres and pg-boss hold investigation, remediation, and follow-up work.
Delivery may be at least once, so handlers use idempotency keys and state
transitions rather than assuming a job runs exactly once.
Review follow-ups are serialized per pull request. Each pass reloads unresolved
bot threads and the current PR head, so redundant queued comment events exit
without repeating replies.

## Deployment contract

Serve the Vite build and API from one public origin so browser authentication,
OAuth callbacks, and webhooks share a stable URL. Run the worker separately,
but give both services the same database, encryption key, internal token, and
operator-managed runtime configuration.

Production operators are responsible for TLS termination, network isolation,
database backups, secret injection, observability, scaling, and rollbacks. The
application does not depend on one infrastructure provider.

### Automation subscription credentials

New automations start with “Choose model”. API-key credentials use the model
broker. ChatGPT subscription credentials use the pinned official client directly.

Sign-in creates a temporary, automatically deleted sandbox running the official
app server. Responder calls `initialize` and `account/login/start` with
`type: "chatgptDeviceCode"`, displays its verification link and code, and waits
for `account/login/completed`. The official client owns OAuth, PKCE, token
exchange and refresh. Responder does not implement provider OAuth endpoints,
embed provider client IDs, or proxy undocumented subscription inference APIs.
See https://developers.openai.com/codex/app-server/.

Pending connections are scoped to the initiating user and workspace, expire after
15 minutes, and hold an encrypted sandbox reference. After successful login, the
native `auth.json` cache is read through the sandbox file API and encrypted in the
workspace credential store. Browser responses contain only UI state and the
credential ID. Cancellation deletes the login sandbox; ephemeral lifecycle limits
bound abandoned sessions. The connection is shared by automations in its workspace.

Subscription runs require the Codex harness, enforced by the API and worker.
A fresh sandbox receives a run-only copy of the native auth cache in a private
directory outside the repository checkout, with directory mode 0700 and file mode
0600. The sandbox file API writes only inside the workspace, so the harness
stages the copy there as root and moves it before Codex starts. The CLI uses
managed ChatGPT authentication and makes inference requests directly. It
receives no custom model-provider override or API key. The existing temporary
broker token is context-only for these runs and cannot authorize model inference.

The run sandbox holds no real token:

- The access token goes into a Daytona secret created for the run and limited
  to `chatgpt.com`. The cache and the mounted environment variable hold only
  the secret's placeholder, which Daytona replaces in HTTPS request headers.
  The worker deletes the secret when the run ends.
- Refresh tokens rotate on every use, so the copy has a placeholder refresh
  token. A refresh attempt inside a run fails that run without affecting the
  stored login.
- Codex reads claims from the ID token but never sends it, so the copy holds an
  unsigned token with only those claims.

Any number of runs can share one subscription at once, and the copy is never
written back. The harness refuses a cache whose refresh token is real or whose
access token is not a Daytona placeholder. Daytona's proxy rejects Codex's
WebSocket transport, so Codex falls back to HTTPS after a few seconds.

Before a run, the worker checks that the stored access token outlives the maximum
runtime plus 30 minutes. If it does not, the worker refreshes the login once in a
separate short-lived sandbox: the official client's `account/read` with
`refreshToken: true` rotates the token, and the result is encrypted and stored.
Only this refresh and model discovery hold the exclusive credential lease. A run
that finds the lease held waits up to four minutes for the other operation, then
uses its result. Leases do not permit automatic takeover: only the owning
operation releases the credential after its sandbox is deleted. An interrupted
owner that cannot finish cleanup requires reconnecting the subscription. The run
sandbox is destroyed using the existing run lifecycle. The access and ID tokens
are redacted from persisted harness output. Subscription execution uses the client's
native filesystem permission profile: model tools may edit the workspace, but cannot
read the auth home (including through symlinks). The trusted launcher runs as root
inside the disposable container so it can create the nested Linux user namespace;
model commands run with dropped capabilities under that namespace and filesystem
policy. The pinned executable is installed outside the writable workspace. Workspace
ownership is restored after credential cleanup. A snapshot must run as root or support noninteractive
sudo, and support the client's Linux sandbox; failures never fall back to unrestricted execution.

Runtime limits and provider subscription quotas apply to subscription runs.
Broker request-count and per-call output-token caps apply only to API-key runs;
native subscription inference does not pass through that broker.
Anthropic subscription login is not offered. A live sign-in and inference test
requires the account holder to complete provider approval; automated tests mock
that boundary.

### Automation provider catalogs

The automation model picker lists providers: OpenAI, Anthropic, Google Gemini,
xAI, Mistral, and DeepSeek. Each provider opens a submenu of models from the AI
Gateway catalog. API keys and subscriptions are managed in model access
settings.

Automations do not store a model credential. The worker picks the inference
source when each run starts from the organization's model access settings: a
ChatGPT subscription for the Codex harness, then the newest active API key for
the provider. Only without either is inference billed through Responder. An
API-key run looks the model up in the key's catalog and uses the provider's ID
for it, since AI Gateway names can differ (`claude-sonnet-4.5` is
`claude-sonnet-4-5-20250929` at Anthropic). If the provider rejects the key or
does not list the model, the run fails; it never falls back to Responder
inference. For a saved connection, the server fetches the provider's current
model catalog using that credential. New keys are checked against the catalog
before storage. Catalog calls
are tenant-scoped and use fixed provider URLs, bounded timeouts, and no redirects.
The picker excludes non-conversational model types and explicitly incompatible
capabilities. Catalog visibility does not guarantee inference quota or access to
every feature of a model; the provider remains authoritative at run time.

OpenAI uses the Responses API, Anthropic uses Messages, and the other providers
use their OpenAI-compatible Chat Completions APIs through provider-specific
broker routes. All broker calls validate provider, model, and run grant, reserve
request/output budgets, and keep provider keys outside the sandbox. New providers
run with OpenCode. The native Codex harness is limited to OpenAI. The Claude
Agent SDK is limited to Anthropic.

Subscription catalogs come from the official client's `account/read` and
`model/list` methods in a temporary sandbox with the encrypted saved auth cache.
Discovery takes an exclusive credential lease, persists any managed refresh,
and deletes the sandbox afterward. It cannot run concurrently with inference
using the same subscription. Subscription model metadata is cached for five minutes per workspace and connection;
in-flight requests share the same discovery. Explicit refresh bypasses cached results.
API-key catalogs reload when opened. There is no hard-coded model list in the picker.
