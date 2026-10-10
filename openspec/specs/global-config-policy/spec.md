# global-config-policy Specification

## Purpose
Defines the invariants that the deployed OMP global configuration under `omp/agent/` must satisfy so that prompt weight, model effort, subagent guards and fallback coverage stay within agreed bounds across future edits and upgrades.

## Requirements

### Requirement: Coordinator-only rules are not injected into subagents
Rules whose content addresses only the root coordinator (currently `main-agent-orchestrator`) SHALL declare `agents: [main]` so that spawned subagents do not receive them, while remaining `alwaysApply: true` for the root session.

#### Scenario: Root session
- **WHEN** a new top-level OMP session starts
- **THEN** the system prompt contains the full `main-agent-orchestrator` content

#### Scenario: Subagent session
- **WHEN** any agent other than `main` (for example `sonic`, `task`, `verifier`) is spawned
- **THEN** its system prompt does not contain `main-agent-orchestrator` content

### Requirement: Communication rules are a single always-on rule
Language, tone and formatting guidance SHALL live in exactly one always-on rule file, `communication.md`, that applies to every agent and preserves all constraints previously stated in `caveman-default` and `chinese-language-preference`.

#### Scenario: Constraint preservation
- **WHEN** the merged rule is compared with the two removed rules
- **THEN** every normative statement of the removed rules (Chinese for user-facing text and questions, English for maintained internal contracts and code comments, caveman lite default with explicit mode switches, verbatim identifiers/commands/errors, professional prose for persisted documents, full sentences for security/destructive/complex content) is present in the merged rule

#### Scenario: No duplicate rule files
- **WHEN** the `omp/agent/rules/` directory is listed
- **THEN** it contains `communication.md` and does not contain `caveman-default.md` or `chinese-language-preference.md`

### Requirement: Trivial roles do not run at maximum effort
The `commit` and `tiny` model roles SHALL use a thinking level no higher than `medium`.

#### Scenario: Effort ceiling
- **WHEN** `modelRoles.commit` and `modelRoles.tiny` are read from `config.yml`
- **THEN** each selector's effort suffix is `low` or `medium`

### Requirement: Subagent request guard is enabled
`task.softRequestBudget` SHALL be a positive integer so that OMP's wrap-up notice and forced-yield guard remain active for every subagent.

#### Scenario: Guard configured
- **WHEN** `task.softRequestBudget` is read from `config.yml`
- **THEN** its value is greater than 0 and not greater than 200

### Requirement: Every role has an explicit fallback policy
Every `modelRoles` key SHALL have a `retry.fallbackChains` entry. The root `default` role SHALL use `[]`; each non-empty entry SHALL contain only exact selectors listed in `enabledModels`.

#### Scenario: Fallback present
- **WHEN** `retry.fallbackChains` is read from `config.yml`
- **THEN** its keys exactly equal `modelRoles`; `default` is `[]`; and every non-empty selector's `provider/model` prefix appears in `enabledModels`

### Requirement: Agent definitions reference roles, not provider strings
Every agent definition under `omp/agent/agents/` that sets `model:` SHALL use a role alias of the form `@<role>` where `<role>` exists in `modelRoles`. `deepseek-worker` SHALL resolve through the `@deepseek` agent override.

#### Scenario: Alias-only agents
- **WHEN** `verifier.md`, `experience-reviewer.md`, `aesthetic-reviewer.md`, `frontend-worker.md`, `gpt-visual-director.md`, `sonic.md`, `task.md`, `purple-reviewer.md` are parsed
- **THEN** each `model:` value starts with `@` and names a key of `modelRoles`

#### Scenario: Resolution unchanged
- **WHEN** the model audit resolves `@review` and `@aesthetic`
- **THEN** both resolve to `openai-codex/gpt-5.6-terra:high`, matching the previously pinned values

### Requirement: Native task concurrency is bounded without a global-cap claim
`task.maxConcurrency` SHALL be `8`, documented as a native per-session ceiling. It SHALL not be described as a global cross-process cap, a controller-lease cap, or a replacement for the runner's documented one-to-four-author dispatch.

#### Scenario: Native task ceiling
- **WHEN** `task.maxConcurrency` is read from `config.yml`
- **THEN** it equals `8`

### Requirement: Confirmed defects use a separate Terra repair owner
`repair-worker` SHALL resolve through `@repair` to `openai-codex/gpt-5.6-terra:high` with an empty fallback chain. It SHALL be a write-capable CODING role in native and controlled execution, while remaining outside the independent product reviewer set. A confirmed post-implementation defect transfers to this role only after the prior writer settles; an incomplete or interrupted initial implementation remains with its original author. Existing controlled gates, leases, graph claims, generations and current-source receipt requirements SHALL remain in effect.

#### Scenario: Repair transfer
- **WHEN** a confirmed implementation defect is handed off after its author has settled
- **THEN** `repair-worker` receives the bounded repair ownership and focused checks, and no policy routes the defect back to the original implementation author by default

#### Scenario: Independent acceptance
- **WHEN** `repair-worker` completes a repair that changes source
- **THEN** it counts as implementation provenance only; verifier, security-reviewer, purple-reviewer, and applicable visual and experience reviewers still require new current-source PASS receipts

### Requirement: Repository and live configuration stay byte-identical after deployment
After deployment, every file under `omp/agent/` that this change touched SHALL be byte-identical to its counterpart under `~/.omp/agent/`, removed files SHALL be absent live, and the snapshot manifest SHALL verify.

#### Scenario: Post-deploy parity
- **WHEN** SHA256 of each changed, added and removed path is compared between repository and live
- **THEN** all hashes match, removed paths do not exist live, and `python scripts/verify_snapshot.py` prints `PASS`

### Requirement: Bounded capability tasks can use four worktree authors
The plan runner SHALL accept integer concurrency values 1 through 4, default to 4, and reject values outside this range. A fixed ready wave MAY contain more tasks than this dispatch cap. Dependency maturity, path/resource exclusions, author and integration gates, serial merges, failure preservation and parent product acceptance SHALL remain unchanged. Independent frontend or backend packages MAY use multiple instances of their existing author role.

#### Scenario: Four independent authors
- **WHEN** four ready packages have frozen interfaces and disjoint ownership
- **THEN** the runner can dispatch all four in isolated worktrees while preserving role routing and subsequent integration checks

#### Scenario: Failure in a four-author batch
- **WHEN** one dispatched author fails
- **THEN** launched siblings settle, subsequent batches and dependent tasks remain undispatched, and evidence is retained

### Requirement: Planning decisions do not require a separate transcription phase
Sol MAY maintain concise planning, decision, task and checkpoint documents. Product code, configuration, tests and generated diagrams SHALL retain assigned authors. Purple PLAN SHALL review the frozen semantic requirements, interfaces, invariants, ownership and dependency graph before dependent implementation; rendered Archify artifacts SHALL NOT be a prerequisite for that semantic review. The required Archify JSON, rendered HTML and established visual/profile checks SHALL be complete before final reviews and delivery. All independent final acceptance roles and current-source receipt requirements SHALL remain in force.

#### Scenario: Approved semantics with rendering still in progress
- **WHEN** Purple PLAN has accepted the frozen semantic plan and independent artifact ownership is assigned
- **THEN** authorized independent implementation may proceed alongside rendering, while missing required final artifacts still prevent product completion

### Requirement: Architecture selection reuses maintained profiles
For a new product Sol SHALL select and record an appropriate maintained architecture profile and module-specific domain depth from concrete requirements. Existing projects SHALL retain their working stack unless an authorized change requires otherwise. Recipe-only entries SHALL NOT be represented as verified scaffolds. Consequential unresolved or stale questions SHALL receive bounded verification; sufficient current template evidence SHALL be reused instead of a mandatory repeated framework search. No profile implies Docker authorization or a mandatory ORM major.

#### Scenario: Existing project outside the catalog
- **WHEN** an existing working project uses another framework
- **THEN** selecting a planning or testing skill does not authorize migration into a catalog profile
