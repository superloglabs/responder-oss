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
  request body. Retries are deduplicated with provider-specific keys.
- Remote MCP destinations must use HTTPS and resolve to public addresses.
  Redirects are revalidated and authorization is not forwarded across origins.
- Repository work runs in a separate sandbox. GitHub credentials stay outside
  the sandbox; the service materializes only the selected repository content.
- Tenant trace responses omit the initial composed runtime instructions. The
  raw stored trace retains them for an operator's private diagnostics.

## Versioning and jobs

Agent configuration and runtime profiles are immutable versions. An
investigation pins both versions when it is created, so later configuration
changes cannot alter a queued or replayed run.

Postgres and pg-boss hold investigation and remediation jobs. Delivery may be
at least once, so handlers use idempotency keys and state transitions rather
than assuming a job runs exactly once.

## Deployment contract

Serve the Vite build and API from one public origin so browser authentication,
OAuth callbacks, and webhooks share a stable URL. Run the worker separately,
but give both services the same database, encryption key, internal token, and
operator-managed runtime configuration.

Production operators are responsible for TLS termination, network isolation,
database backups, secret injection, observability, scaling, and rollbacks. The
application does not depend on one infrastructure provider.
