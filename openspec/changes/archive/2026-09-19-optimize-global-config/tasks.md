## 1. Baseline and failing test

- [x] 1.1 Create branch `fix/optimize-global-config-20260919` from current `main`; confirm clean worktree
- [x] 1.2 Record `.local/optimize-global-config-20260919/baseline.json`: repo HEAD, live SHA256 of `config.yml`, the four rule files, the three agent files, and production `agent.db`/`-wal`/`-shm`, `orchestration.sqlite`/`-wal`/`-shm` hashes (read-only)
- [x] 1.3 Write `tests/config-policy.test.ts` covering every scenario in `specs/global-config-policy/spec.md` that is checkable from repository files (rule scoping, single communication rule, effort ceiling, budget range, fallback coverage, alias-only agents, alias resolution)
- [x] 1.4 Run `bun test tests/config-policy.test.ts`; confirm it fails on the untouched tree for scoping, communication rule, effort, budget, fallbacks and pinned agents

## 2. Rules

- [x] 2.1 Add `agents: [main]` to `omp/agent/rules/main-agent-orchestrator.md` frontmatter; no body change
- [x] 2.2 Create `omp/agent/rules/communication.md` (`alwaysApply: true`) as the union of `caveman-default.md` and `chinese-language-preference.md`; verify each normative sentence of both sources is present
- [x] 2.3 Delete `omp/agent/rules/caveman-default.md` and `omp/agent/rules/chinese-language-preference.md`
- [x] 2.4 Update `omp/agent/notes/workflow-decisions.md` line referencing `chinese-language-preference` to name `communication`
- [x] 2.5 (added after review) Make child-agent references to the orchestrator path-explicit in `task`, `sonic`, `fast-worker`, `frontend-worker`, `baoyu-design-worker`, since subagents no longer receive that rule

## 3. config.yml

- [x] 3.1 Set `modelRoles.commit` and `modelRoles.tiny` to `openai-codex/gpt-5.6-luna:medium`
- [x] 3.2 Set `task.softRequestBudget: 80`
- [x] 3.3 Add `retry.fallbackChains.default: [openai-codex/gpt-5.6-terra:high]` and `retry.fallbackChains.frontend: [openai-codex/gpt-5.6-terra:high]`
- [x] 3.4 Add a comment above `web_search:` stating the built-in tool is intentionally off and research runs through `extensions/web-research-tools.ts`, which consumes `providers.webSearchOrder`

## 4. Agent definitions

- [x] 4.1 `omp/agent/agents/verifier.md`: `model: "@review"`
- [x] 4.2 `omp/agent/agents/experience-reviewer.md`: `model: "@review"`
- [x] 4.3 `omp/agent/agents/aesthetic-reviewer.md`: `model: "@aesthetic"`

## 5. Repository verification

- [x] 5.1 Regenerate `snapshot-manifest.json` entries for changed/added/removed paths (fileCount, totalBytes); run `python scripts/verify_snapshot.py` 闁?PASS
- [x] 5.2 Run `bun scripts/check-models.ts` (model audit) 闁?ok, with `@review`/`@aesthetic` resolving to `openai-codex/gpt-5.6-terra:high`
- [x] 5.3 Run `bun test tests/config-policy.test.ts tests/model-audit.test.ts` 闁?all pass
- [x] 5.4 Update `README.md`: rule count (3), role summary if affected, mention `communication.md`
- [x] 5.5 Write `notes/optimize-global-config-20260919.md`: rationale per decision, evidence paths, rollback command
- [x] 5.6 Commit on the branch; fast-forward `main`

## 6. Deployment to live `~/.omp/agent`

- [x] 6.1 Write `.local/optimize-global-config-20260919/deploy.py` following the existing helper pattern, extended with backed-up deletion and `--rollback`
- [x] 6.2 Run deploy: backup 闁?preimage check 闁?atomic replace of `config.yml`, `main-agent-orchestrator.md`, three agent files 闁?create `communication.md` 闁?delete two old rule files 闁?record manifest `completed: true`
- [x] 6.3 Post-deploy parity: SHA256 of every touched path equal between repo and live; removed files absent live; production DB/WAL/SHM hashes unchanged from 1.2
- [x] 6.4 No-model smoke: `OMP_AMBIENT_LAB_ROOT=D:/omp-automation-lab-20260918 bun scripts/omp-ambient-smoke.ts --probe`; confirm extensions load and `communication` rule is discovered, old names absent
- [x] 6.5 Record deployment result and backup path in the note from 5.5; commit

## 7. Handoff

- [x] 7.1 Report: changed files, backup path, test/audit results, rollback command, and the two deferred items (`enabledModels` pruning, `git push`)
