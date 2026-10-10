# Verification — Business template C

Verified on 2026-09-20 from a newly copied workspace at `D:\Labs\omp\omp-workflow-foundation-20260920-192447\fresh-business-c`; candidate source was not used for dependency installation or runtime output.

## Completed checks

- Clean `pnpm install --frozen-lockfile` completed with the scoped allowed build scripts for Prisma engines, Prisma, and esbuild.
- `pnpm typecheck` passed for the contracts, Nest API, and React web application.
- `pnpm build` passed, including Prisma client generation and Vite production build.
- The documented `pnpm --filter @business-c/api user:provision` command passed from the clean copy with explicit temporary environment variables; it creates a user and rejects a rerun instead of resetting its password or role.
- `pnpm test` passed against an explicitly selected isolated PostgreSQL database. It applied the checked-in migration and exercised invalid request rejection, authentication required, owner-only list/update, other-user denial, session logout invalidation, and bounded login throttling.
- Root browser validation passed after adding the Vite dependency-optimizer configuration for the linked CommonJS contracts package. This fixed the blank page caused by a missing named CJS export in Vite development mode.

## Dependency override verification

Prisma 7.10.0 exactly pins transitive `deepmerge-ts` 7.1.5 and `mysql2` 3.15.3. The template lockfile applies only:

- `@prisma/config>deepmerge-ts` → `8.0.0`
- `prisma>mysql2` → `3.23.1`

An independent lab copy at `D:\Labs\omp\omp-workflow-foundation-20260920-192447\override-probe-business-c` regenerated its lockfile, resolved exactly those versions, and passed `pnpm typecheck`, `pnpm build`, migration, and the same PostgreSQL integration suite against its own `business_c_override_probe` database. Official-registry production audit output is in `D:\Labs\omp\omp-workflow-foundation-20260920-192447\override-probe-audit.json` with zero advisories. The complete dependency audit also exited successfully with zero advisories; evidence is `D:\Labs\omp\omp-workflow-foundation-20260920-192447\template-full-dependency-audit.json`.

## Fixed issues covered by the checks

- The Vite dev server now prebundles the workspace CommonJS contracts package.
- Main and provisioning entry points resolve `apps/api/.env` explicitly.
- Provisioning imports metadata and always disconnects its database client.
- Test execution launches pnpm through Node's JavaScript entry point on Windows, requires an explicit isolated-test attestation, normalizes PostgreSQL URLs, rejects target-overriding query parameters, and does not claim to detect DNS aliases.
- Login throttling is bounded per process by both IP and email; it is deliberately documented as a single-instance baseline.

## Boundaries

This is not a production identity system. It lacks HTTPS deployment policy, distributed rate limiting, recovery and verification flows, audit/monitoring, and a product-specific authorization/security review. The lab PostgreSQL 18.4 binary used for integration testing was an experimental bundled test binary, not a production recommendation. No real credentials, `.env`, generated Prisma client, `dist`, or `node_modules` are part of the candidate template.
