## Purpose

Defines the invariants that the deployed OMP global configuration under `omp/agent/` must satisfy so that prompt weight, model effort, subagent guards and fallback coverage stay within agreed bounds across future edits and upgrades.

## ADDED Requirements

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

### Requirement: Critical roles have a configured fallback
The `default` and `frontend` roles SHALL each have a non-empty `retry.fallbackChains` entry whose targets are exact selectors listed in `enabledModels`.

#### Scenario: Fallback present
- **WHEN** `retry.fallbackChains` is read from `config.yml`
- **THEN** it contains keys `default`, `frontend` and `implement`, each with at least one selector whose `provider/model` prefix appears in `enabledModels`

### Requirement: Agent definitions reference roles, not provider strings
Every agent definition under `omp/agent/agents/` that sets `model:` SHALL use a role alias of the form `@<role>` where `<role>` exists in `modelRoles`, except an agent whose definition explicitly documents a pinned selector (currently `baoyu-design-worker`; `deepseek-worker` is pinned through `agentModelOverrides`).

#### Scenario: Alias-only agents
- **WHEN** `verifier.md`, `experience-reviewer.md`, `aesthetic-reviewer.md`, `frontend-worker.md`, `gpt-visual-director.md`, `sonic.md`, `task.md`, `purple-reviewer.md` are parsed
- **THEN** each `model:` value starts with `@` and names a key of `modelRoles`

#### Scenario: Resolution unchanged
- **WHEN** the model audit resolves `@review` and `@aesthetic`
- **THEN** both resolve to `openai-codex/gpt-5.6-terra:high`, matching the previously pinned values

### Requirement: Repository and live configuration stay byte-identical after deployment
After deployment, every file under `omp/agent/` that this change touched SHALL be byte-identical to its counterpart under `~/.omp/agent/`, removed files SHALL be absent live, and the snapshot manifest SHALL verify.

#### Scenario: Post-deploy parity
- **WHEN** SHA256 of each changed, added and removed path is compared between repository and live
- **THEN** all hashes match, removed paths do not exist live, and `python scripts/verify_snapshot.py` prints `PASS`
