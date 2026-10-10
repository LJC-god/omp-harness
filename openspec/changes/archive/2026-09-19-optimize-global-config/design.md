## Context

See proposal.md — Why. Relevant runtime facts verified against the OMP source (`packages/coding-agent/src/capability/rule-buckets.ts`, `rule.ts`, `task/executor.ts`, `config/settings-schema.ts`):

- A rule with `alwaysApply: true` is inlined into `<generic-rules>` of the system prompt; a rule with a `description` but no `alwaysApply` is listed one line per rule under `<domain-rules>` and readable via `rule://<name>`.
- `ruleAppliesToAgent` drops a rule for agents not matching its `agents` globs; `main` is the top-level session. Rules without `agents` apply to every agent, including each spawned subagent.
- `task.softRequestBudget` is an upper bound combined with bundled ceilings (`scout`/`sonic` 100, `default` 200); `0` disables the guard entirely.
- `retry.fallbackChains` keys may be role names (the existing `implement` entry) and values are exact `provider/model[:effort]` selectors; `omp/agent/lib/model-audit.ts` validates them against the catalog.
- The repository ships its own deployment pattern (`.local/<batch>/deploy.py`): committed clean worktree, per-file live preimage check against a recorded baseline, backup under `~/.omp/backups/<batch>-<timestamp>`, atomic `os.replace`, manifest with `completed` flag.

Constraints: OMP 18.2.6 stays; no runtime/controller code is edited; active sessions are not hot-patched; controller DB, sessions and credentials are untouched.

## Goals / Non-Goals

**Goals:**
- Reduce per-spawn prompt weight without changing what the root coordinator is told.
- Make effort, guard and fallback choices explicit in `config.yml` and enforce them with a repository test.
- Keep every existing `~/.omp/agent/...` path reference valid.

**Non-Goals:**
- Rewriting or shortening the orchestrator/router prose, or changing the product-review ceremony.
- Moving the orchestrator to on-demand (`rule://`) loading for the root session — deferred until a measured trial shows the root-session token share matters and model compliance with "read rule:// first" is verified.
- Cleaning `~/.omp` residue, pruning `enabledModels`, or pushing the repository.

## Decisions

1. **Scope the orchestrator with `agents: [main]` instead of demoting it to a rulebook rule.**
   Alternatives: (a) `alwaysApply: false` + router instruction to read `rule://main-agent-orchestrator` — saves root tokens too, but relies on the model reading it before acting and would change root behavior on every CODING task; (b) split the file into a short always-on core and on-demand notes — larger rewrite, cross-reference churn. Chosen option changes nothing for the root and removes the largest block from every child. It is reversible by deleting one frontmatter line.

2. **Keep `harness-router.md` applying to all agents.** It carries the child-facing contract (`HARNESS_ESCALATION`, `WEB_RESEARCH_REQUIRED`, role allowlists) and is 3.5 KB. Scoping it would require moving those sentences into 16 agent files.

3. **Merge the two communication rules into `communication.md` (new name, both old files removed).**
   Alternative: keep `chinese-language-preference` and fold caveman into it — leaves a misleading name and the same two-file drift risk. A new neutral name plus removal keeps one file. The merged text is a union, not a rewrite: sentences are kept verbatim where possible; only the duplicated "reply in Chinese" statements are collapsed.

4. **`commit`/`tiny` → `luna:medium`, not `low`.** `medium` is the last known-good value (pre-2026-09-07 preimage); `low` is untested for these roles here.

5. **`softRequestBudget: 80`.** Below the bundled `default` ceiling (200) so it actually tightens general agents; below `scout`/`sonic` (100) so it applies uniformly. Forced yield at 120 requests still leaves room for a bounded implementation; the 30-minute wall clock remains the hard stop. `softRequestBudgetNotice` stays default-on.

6. **Fallbacks target `openai-codex/gpt-5.6-terra:high` for both `default` and `frontend`.** It is already the review/security model (audited, quota known), same effort tier as the primaries, and does not introduce a new provider dependency. A cross-provider second hop (`cursor/cursor-grok-4.6-fast`) is intentionally not added for `default`: the orchestrator rules forbid silently substituting authorship models, and a two-hop chain would mask a provider outage longer. `implement` keeps its existing chain.

7. **Agent `model:` values use `@review` / `@aesthetic`.** `experience-reviewer` maps to `@review` (same Terra/high as `verifier`), matching the rule table which already groups both under "Terra high". `aesthetic-reviewer` maps to `@aesthetic`, which `gpt-visual-director` already uses.

8. **Policy test lives in `tests/config-policy.test.ts` and reads the repository copy**, parsing YAML with `js-yaml` from the OMP runtime resolution already used by `model-audit.ts`, or a minimal line parser if that import is unavailable in the test sandbox. It is written first and must fail on the current tree (rule scoping, budget, fallbacks, pinned agents) before edits are made.

9. **Deployment reuses the `.local/<batch>/` helper pattern with one addition: deletions.** For `caveman-default.md` and `chinese-language-preference.md` the helper backs up the live bytes, verifies the preimage hash, then removes the live file; `communication.md` is created. Rollback restores backups and removes `communication.md`.

## Risks / Trade-offs

- [Subagents lose orchestrator context they implicitly relied on] → The orchestrator addresses Sol's duties (ownership, Git, routing, acceptance); child contracts live in agent definitions and `harness-router`. Mitigation: policy test + a post-deploy no-model smoke (`bun scripts/omp-ambient-smoke.ts --probe` under the existing D: lab root) and one real bounded child run; if a child visibly regresses, remove `agents: [main]` (single-line rollback).
- [Merged rule changes wording the models responded to] → Union of sentences, no new constraints; diff reviewed line by line against both sources.
- [Fallback to Terra hides a Kimi outage in UI work] → The resolved-model badge (`showResolvedModelBadge: true`) and `task-health` dispatch notices already surface the actual model; the rule text "report an unavailable required route" still applies to the coordinator.
- [Budget of 80 stops a legitimately long child] → Forced yield returns partial findings as a real report; the existing owner can be re-dispatched. Budget is one number to raise.
- [Manifest/README drift] → `verify_snapshot.py` enforces the file set; README counts are updated in the same commit.

## Migration Plan

1. Branch `fix/optimize-global-config-20260919` in the repository checkout (no worktree unless the user asks).
2. Record baseline: HEAD, live SHA256 of every touched live path, production DB/WAL/SHM hashes (read-only).
3. Write failing `tests/config-policy.test.ts`; run and confirm failure.
4. Apply repository edits; update `snapshot-manifest.json`; run `verify_snapshot.py`, `check-models.ts`, `bun test tests/config-policy.test.ts tests/model-audit.test.ts`.
5. Commit; run deploy helper (backup → preimage check → atomic replace/delete → post-hash check → manifest `completed: true`).
6. Post-deploy: live/repository parity hashes, `verify_snapshot.py`, production DB hashes unchanged, no-model smoke probe.
7. Rollback: helper `--rollback` restores every backed-up file and removes `communication.md`, refusing if live postimages no longer match.

## Open Questions

- Whether `enabledModels` entries with no consuming role (`gpt-6-astra`, `claude-4.6-opus-max`, `gemini-3.8-flash`) are reserves for interactive `/model` use or dead entries. Deferred; does not affect this change.
- When the repository's 12 unpushed commits (plus this change) should be pushed to `origin`; user decision.
