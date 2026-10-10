## Why

The 2026-09-19 read-only review of the live `~/.omp/agent` configuration found that the deployed setup is well governed but pays avoidable cost on every session: 21 KB of `alwaysApply` rules are injected into the root session **and every spawned subagent**, several model roles run at `max` effort for trivial work, the subagent request guard is disabled (`task.softRequestBudget: 0` overrides OMP's bundled 200/100 caps), the UI route has no fallback, and three agent definitions pin a provider/model string instead of the role alias, creating a second source of truth. The retained product trial in `notes/convergence-20260919.md` (603 s, no CLI produced) shows planning and model waiting dominating; reducing per-spawn prompt weight and adding guards is the cheapest next step before another measured trial.

## What Changes

- **Rule scoping**: `main-agent-orchestrator.md` is scoped to the root session (`agents: [main]`), so subagents no longer receive ~11 KB of coordinator-only prose. Its content and file name are unchanged, so every existing `~/.omp/agent/...` reference remains valid.
- **Rule consolidation**: `caveman-default.md` and `chinese-language-preference.md` are merged into one always-on rule, `communication.md`, preserving every stated constraint (Chinese for user-facing text, English for maintained internal contracts, caveman lite default and mode switches, verbatim identifiers/commands/errors, professional prose in persisted documents). The two source files are removed. **BREAKING** for anything that addresses those two rule names (`rule://caveman-default`, `rule://chinese-language-preference`, `disabledRules`); the repository audit found no such reference outside the snapshot manifest and README.
- **Model effort**: `modelRoles.commit` and `modelRoles.tiny` return from `luna:max` to `luna:medium` (their pre-2026-09-07 values). No other selector, provider or effort changes.
- **Subagent guard**: `task.softRequestBudget` changes from `0` (guard disabled) to `80`: wrap-up notice at 80 assistant requests, forced yield at 120. Bundled `scout`/`sonic` ceilings (100) still apply where lower.
- **Fallback chains**: add `retry.fallbackChains.frontend: [openai-codex/gpt-5.6-terra:high]` and `retry.fallbackChains.default: [openai-codex/gpt-5.6-terra:high]`, so a Kimi or Sol outage degrades to an already-audited model by configuration instead of by a live coordinator decision. The existing `implement` chain is unchanged.
- **Single source of truth for agent models**: `verifier.md` and `experience-reviewer.md` use `model: "@review"`, `aesthetic-reviewer.md` uses `model: "@aesthetic"`. All three resolve to the same `openai-codex/gpt-5.6-terra:high` today, so runtime behavior is unchanged; a future role change in `config.yml` now propagates.
- **Documentation**: a comment in `config.yml` states that the built-in `web_search` tool stays disabled and research goes through the `web-research-tools.ts` extension; README rule count and role summary updated; a new `notes/optimize-global-config-20260919.md` records rationale, evidence and rollback.
- **Policy test**: a new `tests/config-policy.test.ts` asserts the above invariants against the repository copy, so a later edit that regresses them fails `bun test`.

Explicitly **not** in this change: `enabledModels` pruning (`gpt-6-astra`, `claude-4.6-opus-max`, `gemini-3.8-flash` remain), deletion of `~/.omp` residue directories or backup files, pushing `omp-config` to `origin`, any change to the product-review ceremony (red/blue/purple, Archify diagrams), `defaultThinkingLevel`, concurrency or timeouts.

## Capabilities

### New Capabilities
- `global-config-policy`: the invariants the deployed `~/.omp/agent` configuration must satisfy — rule scoping and consolidation, effort floors/ceilings per role class, subagent request guard, fallback coverage for critical roles, and role-alias-only model references in agent definitions.

### Modified Capabilities
- (none — this repository has no prior OpenSpec specs)

## Impact

- Repository files: `omp/agent/config.yml`, `omp/agent/rules/main-agent-orchestrator.md`, `omp/agent/rules/communication.md` (new), `omp/agent/rules/caveman-default.md` and `chinese-language-preference.md` (removed), `omp/agent/agents/{verifier,experience-reviewer,aesthetic-reviewer}.md`, `snapshot-manifest.json`, `README.md`, `notes/`, `tests/config-policy.test.ts` (new).
- Live deployment: the same paths under `~/.omp/agent/`, deployed with the repository's existing preimage-checked, backed-up, atomic per-file helper pattern (new helper under `.local/optimize-global-config-20260919/`). Two live rule files are deleted and one created; the helper must handle deletion with backup.
- Runtime: no OMP version change (18.2.6). Active sessions keep their loaded rules; the change applies to new sessions. No controller database, session, credential or product source is touched.
- Verification: `python scripts/verify_snapshot.py`, `bun scripts/check-models.ts` (model audit), `bun test tests/config-policy.test.ts tests/model-audit.test.ts`, live hash comparison after deploy.
