# Architecture catalog

Sol selects a profile for a new product from concrete requirements and records a short decision in the existing plan. The profile constrains repeated infrastructure choices while leaving business architecture to Sol. Existing projects keep their established stack. The current repository for recipes is `<repo>/templates`; availability and tested versions are recorded there, not inferred from this table.

| Profile | Framework route | Selection evidence | Current recipe scope |
|---|---|---|---|
| A: frontend application | React + Vite + TypeScript | Presentation or client interaction with no owned backend, or an already provided API | Selection recipe; do not invent a backend or claim a verified scaffold |
| B: integrated Web application | Next.js + TypeScript; PostgreSQL + Prisma when persistence is required | Website is the principal client, server rendering/public discoverability matters, and colocated server behavior meets lifecycle/deployment needs | Selection recipe; validate required server/auth/persistence boundaries before claiming readiness |
| C: separate business application | React + Vite frontend; NestJS default Express backend; PostgreSQL + a pinned compatible stable Prisma release; pnpm workspace and shared Zod contracts | Independently consumed API, separate client/backend ownership or lifecycle, and independently verifiable work packages | `templates/business-c`; consult its README and verification record for the actual tested foundation and limitations |
| D: domain-oriented business application | Reuse C's verified runtime; add application/domain/infrastructure boundaries only in relevant modules | Substantial business invariants, state machines, transactions or external integrations need explicit ownership and testable domain boundaries | C-based architecture recipe, not evidence that a specific domain implementation has been verified |

The A/B/C/D names identify choices, not a complexity ranking. A complex domain may live in B when one deployment fits; public-facing C/D can use a separately verified Next.js client variation when SSR is required. Do not mix variants speculatively. Pages, line counts and model preferences do not determine the profile.

## New admin and workbench UI baseline

For a new admin or workbench application on a React/Vite route, use React + Vite + TypeScript with Tailwind, shadcn/ui configured for the Radix base, and `lucide-react`. The selected author uses `skill://shadcn` to initialize the project context, read component documentation before composition, and records the exact package versions and lockfile. This is a new-project baseline, not a migration rule for established applications and not a reason to add components that the product does not need.

`templates/business-c` remains a verified React/Vite business foundation, but its current web package does not provide the Tailwind, shadcn/Radix, or Lucide baseline. Do not describe that recipe as supplying it. A foundation owner adds and verifies the baseline once before dependent UI authors start; its handoff names the commit, commands, `components.json` base/aliases, shared shell/component paths, and the single owner of the manifest, lockfile and global styles.

## Selection and freezing

Identify the clients, persistence/sharing requirements, authorization boundaries, rendering/distribution requirements, business invariants and deployment constraints. Select the matching maintained route and note up to a few decisive reasons. Name the required domain depth per module and any unverified adaptation. Freeze only the interfaces and ownership needed for the first safe work packages; refine future detail without changing dispatched contracts. Use sufficient current evidence instead of reopening framework research.

For a route outside the library, Sol records the requirement the available routes cannot meet, checks the relevant official source and runs a bounded feasibility probe. Ordinary authorized engineering decisions need no repeated user permission. Never treat the library as authority to override explicit product requirements or migrate an unrelated existing project.

## Domain and distribution decisions

For simple record operations, a conventional module/controller/service/persistence structure may suffice. For coupled state transitions, pricing, reservation, settlement, inventory or other meaningful invariants, Sol can isolate domain operations, value constraints and transaction boundaries. Scope layering to the modules that benefit; a general-purpose repository abstraction or event bus is not mandatory.

Separately evaluate domain events, durable jobs and service extraction from concrete requirements. A domain layer does not imply microservices. Independent scaling, deployment or failure isolation can justify service boundaries, with the necessary consistency and operational checks. Retain atomic ownership of shared invariants during parallel implementation.

## Reuse and author dispatch

Reuse a verified template at its recorded commit/lockfile. The foundation owner adapts contracts, shared shell, schema and runtime once; other authors receive their exact interfaces and working commands. Publish work packages by independently accepted capability, not entire frontend/backend monopolies or one task per file. Use up to four author worktrees within the product's eight-child coordination budget. Independent authors can share a role; shared source files and runtime resources retain one owner or explicit isolation.

Templates are foundations, not product acceptance. Project-specific authorization, data ownership, concurrency invariants, recovery, accessibility and independent red/blue/purple/visual/experience checks remain required where applicable. A local demo without authentication cannot be deployed as a multi-user product. Use `product-testing` for durable behavioral checks and the project's existing browser driver for real input evidence.
