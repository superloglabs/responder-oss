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
  stores the resulting Linear identifier and link.
- Langfuse context uses encrypted project-scoped API keys outside the sandbox.
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
A fresh sandbox receives the native auth cache in a private directory outside the
repository checkout, with directory mode 0700 and file mode 0600. The CLI uses
managed ChatGPT authentication and makes inference requests directly. It receives
no custom model-provider override or API key. The existing temporary broker token
is context-only for these runs and cannot authorize model inference.

The worker acquires an exclusive credential lease for each subscription run to
prevent concurrent refresh-token rotations. A concurrent run fails with an explicit
subscription-in-use message. After execution (including failures), the native cache
is read back and encrypted under the owning lease, and its sandbox copy is removed.
Lease deadlines record the maximum runtime plus cleanup time, but do not permit
automatic takeover: only the owning operation releases the credential after cleanup.
An interrupted owner that cannot finish cleanup requires reconnecting the subscription. The sandbox
is destroyed using the existing run lifecycle. Known original and refreshed tokens
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

The model picker starts with providers: OpenAI, Anthropic, Google Gemini, xAI,
Mistral, DeepSeek, and Groq. After selecting a saved connection or adding an API
key, it fetches the provider's current model catalog using that credential on the
server. New keys are checked against the catalog before storage. Catalog calls
are tenant-scoped and use fixed provider URLs, bounded timeouts, and no redirects.
The picker excludes non-conversational model types and explicitly incompatible
capabilities. Catalog visibility does not guarantee inference quota or access to
every feature of a model; the provider remains authoritative at run time.

OpenAI uses the Responses API, Anthropic uses Messages, and the other providers
use their OpenAI-compatible Chat Completions APIs through provider-specific
broker routes. All broker calls validate provider, model, and run grant, reserve
request/output budgets, and keep provider keys outside the sandbox. New providers
run with OpenCode; the native Codex harness is limited to OpenAI and the Claude
Agent SDK to Anthropic.

Subscription catalogs come from the official client's `account/read` and
`model/list` methods in a temporary sandbox with the encrypted saved auth cache.
Discovery takes an exclusive credential lease, persists any managed refresh,
and deletes the sandbox afterward. It cannot run concurrently with inference
using the same subscription. Subscription model metadata is cached for five minutes per workspace and connection;
in-flight requests share the same discovery. Explicit refresh bypasses cached results.
API-key catalogs reload when opened. There is no hard-coded model list in the picker.
