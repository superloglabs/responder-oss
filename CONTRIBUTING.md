# Contributing to Responder

Thanks for helping improve Responder. Bug reports, documentation, tests, and
focused code changes are welcome.

## Before you start

- Use Node.js 24 or newer, pnpm 11, and Docker.
- Open an issue before a large refactor, a new runtime dependency, or a change
  to authentication, billing, credential handling, or tenant boundaries.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
- Never commit `.env` files, provider credentials, tokens, private keys, or
  customer data. Use synthetic fixtures in tests.

## Local setup

```bash
pnpm local:setup
pnpm local:dev
```

The setup command creates a gitignored local environment, starts Postgres, and
applies the schema. Provider credentials are optional until you exercise an
integration. Public OAuth callbacks require the tunnel workflow described in
[docs/integrations.md](docs/integrations.md).

## Making a change

1. Create a branch named `<your-handle>/<short-kebab-summary>`.
2. Keep the change focused and add tests next to the code it changes.
3. For integration boundaries, cover invalid signatures or state, tenant
   isolation, retries, and replay behavior where relevant.
4. Run the full validation suite:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```

5. Open a ready-for-review pull request with the motivation, validation, and
   any operational or security impact.

For schema changes, run `pnpm db:generate`, inspect the SQL, and verify that a
fresh database can apply every migration. Keep deployed schema changes
backward-compatible while services are rolling between versions.

## Contribution terms

By submitting a contribution, you agree that it is licensed under the Apache
License 2.0 on the same terms as the rest of the project. You must have the
right to submit the work.

If automated assistance materially contributed to a pull request, say so in
the pull request description and explain what you reviewed or changed. You are
responsible for understanding and validating everything you submit.

All contributors must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
