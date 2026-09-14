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

For repositories attached to standard agents, the worker maintains one atomic
codebase knowledge snapshot per GitHub repository. A daily scheduled sweep resolves GitHub
default-branch heads without downloading repository archives. It runs the
knowledge-generation sandbox only when a head changed. Agent creation, agent
repository changes, and a tenant-requested manual refresh use the same
exclusive per-repository queue. Each successful snapshot stores 8–12 Markdown
guides, 8–12 restricted-syntax D2 diagrams, and the exact repository revisions
that support them.

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
- Linear context uses its read-only MCP endpoint. Ticket creation goes through
  a separate controlled tool that records a stable request before writing and
  stores the resulting Linear identifier and link.
- Langfuse context uses encrypted project-scoped API keys outside the sandbox.
  The worker connects to the project's MCP endpoint through the protected remote
  fetch boundary and exposes only an exact read-only tool allowlist.
- Repository work runs in a separate sandbox. GitHub credentials stay outside
  the sandbox; the service streams selected repository snapshots through
  bounded worker scratch storage and into the isolated workspace without
  buffering the complete archive in worker memory.
- Knowledge generation uses the same credential-free repository snapshot
  boundary and never mounts workspace secrets. Tenant APIs scope snapshots by
  organization. Investigation runs can list, search, and read only snapshots
  for repositories tied to their pinned agent configuration version, and are instructed to
  verify incident-specific claims against their current source checkout.
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
Codebase knowledge refreshes are serialized per repository. Agents that share a
repository reuse the same snapshot. Failures retain the last usable snapshot
while recording the refresh error.

## Deployment contract

Serve the Vite build and API from one public origin so browser authentication,
OAuth callbacks, and webhooks share a stable URL. Run the worker separately,
but give both services the same database, encryption key, internal token, and
operator-managed runtime configuration.

Production operators are responsible for TLS termination, network isolation,
database backups, secret injection, observability, scaling, and rollbacks. The
application does not depend on one infrastructure provider.
