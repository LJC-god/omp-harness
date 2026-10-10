# Product review contract

This is the finite handoff review for a complete, reviewable PM product definition. It does not create a new user approval, research budget, product-authority document, controller, or replacement for Purple PLAN and the existing engineering gates.

## Authoritative files and ownership

- PM alone writes `docs/product/PRD.md` and `docs/product/research.md`.
- `PRD.md` is the sole product authority. It has a version, stable requirement IDs and `Review status: complete and reviewable` only when it is complete.
- `research.md` preserves sources, source categories, limitations, decision links, actual PM receipt identity and unresolved questions.
- Sol alone writes `docs/product/decisions.md`, recording each finding as accepted, narrowed, rejected or deferred and linking it to a PRD version and revision. Sol fixes the adjudications and allowed revision scope before the final review snapshot; routine review completion is retained in native task/checkpoint or external evidence, never appended to a frozen decision file.
- Engineering plans/contracts cite PRD requirement IDs and version; they do not restate product rules as another authority. Sol resolves conflicts.

## Snapshot and initial review

Sol first reads `xd://omp_product_review` to understand its returned fields and schema. Sol then requests its `snapshot` action from the product root. The runtime, not task prose, reads the required `docs/product/PRD.md` and `docs/product/research.md`, includes `docs/product/decisions.md` if it exists, and returns the snapshot ID, manifest identity and review schema.

Sol starts both non-blocking native reviewer tasks with the identical runtime snapshot, normally omitting `outputSchema`. The runtime installs that snapshot's authoritative schema and appends its document identity map to each task. If an explicit `outputSchema` is necessary, pass the returned `reviewSchema` unchanged; never reconstruct or augment it. Do not copy document hashes into task prose. Reviewers read the same frozen files independently and never read each other's initial findings. `product-reviewer` applies the preserved BMAD rubric to value, completeness, scope and handoff. `product-rules-reviewer` applies the preserved pm-critic material to business states, data changes, exceptions, cancellation and recovery. Each uses source classification, exact quotations, consequence and a minimum correction. Zero findings is valid.

Reviewers return only the runtime-supplied output shape. A schema-valid receipt proves only machine validation, never a semantic PASS. Sol waits until all required reviews for the current round (both reviewers in the initial round), including any receipt recovery, have settled. Before editing any snapshot document, including `decisions.md`, or dispatching a PM revision, Sol invokes the runtime `check(snapshotId, reviewer, taskName)` for every settled review while that snapshot remains unchanged. The check collects the actual native-task/hub/async receipt, verifies source identity, model, schema and verbatim quotations, and retains every failure. Sol does not hand-copy hashes, results or receipts into the check. If a check is blocked only because model metadata is absent, collect the settled hub receipt for that same task, recheck the linked failure, and do not respawn a reviewer solely to obtain metadata.

## Adjudication and bounded recheck

Only after the relevant unchanged-snapshot checks are VALID does Sol verify evidence, deduplicate overlapping findings, calibrate severity, and record accept/narrow/reject/defer with reasons in `decisions.md`. The original product artifact owner revises only accepted items in the two PM-owned files and preserves the finding-to-revision link. If its native session has ended, Sol assigns a new bounded `pm-worker` revision task with the original artifact/task reference, decision record and allowed paths; it identifies the new attempt, changes only accepted items and does not restart research. Each reviewer whose assigned area changed reviews the current runtime snapshot independently; unchanged coverage may be reused only when the runtime's current-source rules permit it.

End the loop when accepted blockers are resolved, required affected rechecks are present and material decisions are closed. Do not append “rechecked” or similar bookkeeping to `decisions.md` after the final snapshot: that would invalidate the snapshot without a semantic change. Retain check receipts outside the snapshot. If a decision or revision scope genuinely changes, create a new snapshot and recheck the affected scope. Do not add a third synthesis reviewer or require endless agreement. A changed, missing, incomplete, unparsable, stale or citation-mismatched input fails explicitly and retains its evidence; it never becomes a silently repaired success. Once this closes, Purple PLAN still reviews the frozen engineering semantic plan before implementation.
