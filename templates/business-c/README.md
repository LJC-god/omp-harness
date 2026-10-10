# Business template C — React, NestJS, PostgreSQL

This is a small, runnable foundation template: a React + Vite + TypeScript browser UI, a NestJS (Express) REST API, PostgreSQL persistence through Prisma, and shared Zod contracts.

It demonstrates one vertical slice: list work items, create a work item, and toggle its completed state. It is intentionally not a full product.

## Status and boundary

The template has a small local authentication baseline: CLI/env-provisioned users, Node `crypto.scrypt` password hashes, server-side session records, `HttpOnly`/`SameSite=Lax` cookies, same-origin checks for unsafe requests, bounded in-memory login throttling by both IP and email, logout invalidation, and owner-scoped work items. It has no default password and no cloud identity provider.

It remains a foundation proof, not a production-ready identity system. Before full-product use, configure HTTPS cookie policy, account recovery, distributed rate limiting (the included limiter is per process), audit/monitoring, a deployment-specific origin policy, and a security review.

## Requirements

- Node.js 24 or newer
- pnpm 11.13.0
- A reachable PostgreSQL database supplied through `DATABASE_URL`

Every JavaScript dependency is pinned to an exact stable release in `package.json` and resolved in `pnpm-lock.yaml`. The selected versions are React 19.2.3, Vite 8.3.0, NestJS 12.0.3, Prisma 7.10.0, PostgreSQL driver `pg` 8.16.3, Zod 4.6.5, and TypeScript 5.9.3. Prisma 8's registry `latest` was a release candidate when this template was created, so it is intentionally not used.

### Dependency-audit status

Prisma 7.10.0 exactly pins transitive `deepmerge-ts` 7.1.5 and `mysql2` 3.15.3, which had two high and one moderate advisory. This template uses two narrowly scoped pnpm overrides: `@prisma/config>deepmerge-ts` 8.0.0 and `prisma>mysql2` 3.23.1. A fresh lab probe with those overrides cleared the official-registry production audit and passed Prisma generation, type-checking, production build, migration, and the PostgreSQL integration suite. Reassess the overrides when Prisma publishes compatible upstream stable pins.

## Launch

1. Copy the API environment example and set the database URL:

   ```powershell
   Copy-Item apps/api/.env.example apps/api/.env
   # Edit apps/api/.env and set DATABASE_URL to your PostgreSQL database.
   pnpm install --frozen-lockfile
   pnpm --filter @business-c/api db:migrate
   pnpm --filter @business-c/api user:provision
   ```

2. In one terminal, start the API:

   ```powershell
   pnpm dev:api
   ```

3. In another terminal, start the web application:

   ```powershell
   pnpm dev:web
   ```

Open the Vite URL (normally `http://localhost:5173`). Set `VITE_API_BASE_URL` when the API is not at `http://localhost:3000`.

Set `AUTH_USER_EMAIL`, `AUTH_USER_PASSWORD`, and `AUTH_USER_ROLE` (`admin` or `user`) before `user:provision`. The command rejects missing values and never creates a default account. Set `PUBLIC_ORIGIN` to the browser origin, normally `http://localhost:5173`.

## Checks

```powershell
pnpm typecheck
pnpm build

# Use a separate, explicitly supplied database. This command refuses to run
# when TEST_DATABASE_URL is absent or equals DATABASE_URL.
$env:TEST_DATABASE_URL = 'postgresql://.../isolated_test_database'
$env:TEST_DATABASE_ISOLATED = '1' # operator attests this URL is an isolated test database
pnpm test
```

The integration test requires the explicit `TEST_DATABASE_ISOLATED=1` attestation and rejects a normalized `TEST_DATABASE_URL` that targets the configured development database. It also rejects target-overriding query parameters, but it cannot identify DNS aliases that resolve to the same host; the operator must still supply a separate database. It applies the checked-in migration only to that test URL, then makes real HTTP requests against an in-process Nest API to verify invalid input is rejected and create/list/toggle operations persist in PostgreSQL.

## Layout

- `packages/contracts` owns shared Zod request and response contracts.
- `apps/api` owns the NestJS API, Prisma schema/migration, seed, and integration test.
- `apps/web` owns the React UI and its API client.

No Docker, embedded PostgreSQL downloader, persistent services, real secrets, cloud identity provider, or production authentication configuration are included.
