
<a href="https://superlog.sh">
  <img width="1200" height="627" alt="Twitter post - 53" src="https://github.com/user-attachments/assets/c0669628-3aea-406e-bee2-ceea283d4956" />

</a>

<div align="center" style="margin:24px 0;">
  
<br />

[![Last Commit](https://img.shields.io/github/last-commit/superloglabs/responder-oss?labelColor=333333&color=666666)](https://github.com/superloglabs/responder-oss/commits/main)
[![Commit Activity](https://img.shields.io/github/commit-activity/m/superloglabs/responder-oss?labelColor=333333&color=666666)](https://github.com/superloglabs/responder-oss/graphs/commit-activity)
[![Apache 2.0 License](https://img.shields.io/badge/License-Apache_2.0-555555.svg?labelColor=333333&color=666666)](./LICENSE)
<br>
[![Discord](https://img.shields.io/discord/1511214206123380867?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/wJ56aRh8hx)
<a href="https://www.ycombinator.com"><img src="https://img.shields.io/badge/Y%20Combinator-P26-orange" alt="Y Combinator P26"></a>
[![Follow @superlogYC on X](https://img.shields.io/twitter/follow/superlogyc?logo=X&color=%23f5f5f5)](https://twitter.com/intent/follow?screen_name=superlogYC)

</div>

# Responder

Responder investigates production alerts from Sentry, Datadog, Slack, and
connected MCP servers. It keeps tenant configuration in Postgres, queues work
for a separate worker, and runs repository inspection in an isolated sandbox.

This repository contains the web application, API, worker, shared domain code,
and database migrations. Hosted-service infrastructure and marketing pages are
maintained separately.

## What it does

- Watches selected Slack channels and Sentry projects for new alerts.
- Connects GitHub, Slack, Sentry, Datadog, Vercel, ClickStack, and custom MCP
  servers.
- Investigates incidents with a versioned operator-managed runtime profile.
- Produces structured reports, issues, Slack updates, and optional remediation
  pull requests.
- Separates every organization's data, credentials, resources, and jobs.

## Quick start

You need Node.js 24 or newer, pnpm 11, and Docker.

```bash
git clone https://github.com/superloglabs/responder-oss.git
cd responder-oss
pnpm local:setup
pnpm local:dev
```

The setup command installs dependencies, generates a gitignored `.env.local`,
starts Postgres, applies the migrations, and creates a local example runtime
profile. The development command prints the local HTTPS address. Open it,
create an account, and create the first workspace.

The UI and authentication flow work without provider credentials. Set
`DAYTONA_API_KEY` to store workspace secrets or run investigations, and set
`OPENAI_API_KEY` to run investigations. Restart the stack after changing
`.env.local`. See [.env.example](.env.example) for all configuration.

Provider OAuth and webhooks require a public HTTPS origin. The local tunnel
workflow is documented in [docs/integrations.md](docs/integrations.md).

Stop the stack without deleting its database:

```bash
pnpm local:down
```

## Repository layout

```text
apps/control-plane  React application and Hono API
apps/worker         Investigation and remediation worker
packages/core       Database, security, provider, and queue logic
drizzle             Versioned Postgres migrations
scripts             Isolated local-development tooling
```

## Deployment

Responder is designed as two long-running Node.js services backed by one
Postgres database:

1. Build and serve `apps/control-plane/dist` at your public origin.
2. Route `/api/*` on that origin to the control-plane service.
3. Run the worker with the same database and encryption configuration.
4. Apply every migration in `drizzle/` before starting a new release.
5. Store all credentials in your deployment's secret environment.

The included control-plane and worker Dockerfiles are generic building blocks;
networking, database hosting, TLS, backups, and release automation are left to
the operator. See [docs/architecture.md](docs/architecture.md) for service and
security boundaries.

## Development

Run the complete validation suite before opening a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For schema changes, run `pnpm db:generate`, inspect the generated SQL, and test
the migrations against a fresh database.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Responder is licensed under the [Apache License 2.0](LICENSE). The Inter font
is distributed under the SIL Open Font License; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Product and provider names
and logos are governed separately; see [TRADEMARKS.md](TRADEMARKS.md).
