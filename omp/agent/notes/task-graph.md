# Opt-in task-graph delivery

Use this method only after the serial one-task method in `worktree-delivery.md` is understood and its preparation rules have been met. It is an opt-in control-plane supplement for several independently scoped task worktrees that share one Git common directory. It does not replace the serial Git-owner procedure for creating worktrees, handling conflicts, or accepting the product. The separately documented, user-invoked `task-plan-automation` entry may create its own real roots under its explicit runner contract after Root approves the plan and the user or a coordinator acting under existing user authorization explicitly invokes it; this controller remains a control plane and does not dispatch work on its own. `merge-queue.md` is a separate opt-in integration phase after a node is delivered.

Every participating root session must actually be in its own registered task worktree. Before its own claim, each participant follows the existing `workspace_prepare`, `project_register` or `project_get`, `run_begin`, baseline, and generation workflow in that real root; an unbound sibling may still complete those non-source preparation steps after another node has claimed. Once a project is bound to its claimed node, legacy baseline capture, lease acquire/renew/release, and generation advance are rejected so they cannot replace the reserved token or generation. An active graph blocks `safe_write` throughout the shared common directory. Native `task` has no per-call cwd: an assignment sentence or a fabricated host cwd does not move an author. Complete `/move` and verify the cwd before registration, claim, or `project_spawn`.

## Plan and create

From the clean, registered target-root project and its owning run, call `omp_control` with `action: "task_graph_create"`, `projectId`, `runId`, an optional opaque `graphId`, and `graphPlan`:

```json
{
  "targetRef": "main",
  "tasks": [
    {
      "id": "api",
      "writePaths": ["src/api"],
      "sharedResources": ["schema/customer"],
      "dependsOn": []
    },
    {
      "id": "ui",
      "writePaths": ["src/ui"],
      "sharedResources": [],
      "dependsOn": [{ "taskId": "api", "maturity": "verified_commit" }]
    }
  ]
}
```

The plan has 1–64 unique task IDs. Every task requires all three arrays: nonempty repository-relative `writePaths`, `sharedResources` (use `[]` when none), and `dependsOn` (use `[]` when none); dependencies must be acyclic. Paths are canonical directory/file prefixes, not globs: absolute paths, `.`/`..`, `.git`, `.omp`, Windows reserved names, trailing dot/space, and wildcard syntax are rejected. Resource names are lowercase slash-separated identifiers. `verified_commit` means a delivered upstream commit must be in the dependent worktree's current HEAD. `integrated` adds the stricter requirement that the target ref already contains that upstream commit.

Creation freezes the normalized plan. Repeating the same `graphId` is idempotent only for the same plan, target project/common Git directory, creator run, owner, and generation; a different value is `TASK_CONFLICT`. Use `task_graph_status` with `projectId` and `graphId` from a root in the same common Git directory to inspect each node and its blocking dependencies that are not yet `delivered`. That `blocking` list is informational: it does not prove the local branch contains a `verified_commit`, or that `integrated` is present in the target ref. Only `task_claim` is the authoritative dependency-maturity and conflict check. Status does not dispatch work or make a planned task ready.

## Claim and execute one node

For each author worktree, first prepare/register that worktree and begin its own run. Then atomically call `task_claim` with `projectId`, `runId`, `graphId`, `taskId`, and an author `idempotencyKey`. Keep the returned `claimToken`, branch, `claimHead`, and `targetHead` in the handoff. A duplicate claim refreshes its lease only when the same owner, run, worktree branch, author key, and claim HEAD still match.

The claim is rejected unless the worktree is clean, on a non-target branch based on the current target ref, has no conflicting writer/lease or active graph binding, and dependencies satisfy their declared maturity. It also atomically rejects overlapping `writePaths` or equal `sharedResources` held by any active graph node in the same Git common directory, including a different graph. This is a path/resource conflict check, not semantic conflict detection or operating-system isolation.

Use the existing `project_spawn` to execute the author. For a writing author it must carry the exact same `projectId`, `runId`, `idempotencyKey`, `graphId`, `taskId`, and `claimToken`; the controller moves the node from `claimed` to `running`. An ordinary author spawn without that binding, or a token from another worktree/run/generation, is rejected. Read-only reviewers use the normal frozen-gate route and do not receive or need the claim token. Do not dispatch across roots automatically in the ordinary manual route: Sol moves each real session, performs the existing preparation, and starts each author explicitly. The only documented exception is a Root-approved plan explicitly invoked through `task-plan-automation` by the user or a coordinator acting under existing user authorization; it still uses these real root-bound claims and has no automatic retry, reconciliation, cleanup, or OS-isolation guarantee.

## Deliver a verified commit

After the author has succeeded, the task worktree must contain a clean, committed result. For a new eligible `integration-v1` run, root executes its frozen argv `checkCommand` through `run_check` against that current source; otherwise run the frozen required gates in that same project/run and inspect `run_status`/`run_complete` until the run is complete. `integration-v1` does not apply to high-risk or legacy/frozen runs. Then call `task_deliver` with `projectId`, `runId`, `graphId`, `taskId`, and the exact `claimToken`.

Delivery requires the successful matching author receipt, the current run/generation and the run's frozen integration check or required gates, the claimed branch, a clean worktree, a descendant of `claimHead`, at least one new commit, and changes from `claimHead` through HEAD wholly inside the node's declared paths. It records `verifiedCommit` and releases the node path leases. Its result always reports `integrated: false` and `productComplete: false`: it neither merges the branch into `targetRef` nor completes the product checkpoint.

An upstream `verified_commit` task can unblock a dependent worktree only after that worktree actually incorporates the recorded commit. For an `integrated` dependency, the target ref must really contain the upstream commit. A delivered node may enter the explicit FIFO protocol in `merge-queue.md`; graph delivery alone has no integration lock, automatic cross-root merge, or automatic candidate rebuild after target movement.

## Optional queued integration

After `task_deliver`, the target-root owner may explicitly enqueue that exact delivered node through `merge_enqueue`. Read `merge-queue.md` before enqueueing, preparing a candidate, verifying it, applying it, inspecting queue state, or reconciling uncertainty. The graph binds author work; the queue binds a later integration attempt. Neither action moves a session, creates a worktree, dispatches a model across roots, or completes the target product checkpoint.

## Failure, reconciliation, and manual repair

Failed or interrupted work retains its active claim and occupied scopes. Do not wait for a lease to expire, invent a replacement token, delete the worktree, or retry automatically. First preserve the branch, receipt, session and observed worktree effects, then use the existing `task_reconcile` recovery path where applicable to prove the author stopped and its side effects are known.

Only then may the same owner call `task_claim_reconcile` with `projectId`, `runId`, `graphId`, `taskId`, and `claimToken`:

- A `claimed` node with no spawned author can become `cancelled` only when there is no active writer and its branch, HEAD and clean state still equal the claim.
- A failed/interrupted author requires the matching existing recovery record from `task_reconcile`; the node becomes `interrupted` and its graph leases release.
- If the author succeeded but delivery cannot proceed because gates are missing, stale, or failed, the branch has no new commit, or its changes fall outside the declared scope, reconciliation can mark the node `failed` only after no activity remains and the clean branch/ancestry evidence is retained. The branch is evidence; create a new graph task for a repair or replanning.

No reconciliation state is retryable. A manual repair begins with a new graph task and a newly inspected worktree/run. The isolated recovery regression covers the controller simulation; perform a real process and side-effect inspection before relying on a live interruption recovery.

## Limits, rollout, and rollback

This feature coordinates declared Git scopes and resources through the controller DB. It does not provide OS isolation, an automatic worktree creator/cleaner, cross-root dispatch, semantic conflict resolution, automatic retry, or product acceptance. The separate optional merge queue serializes integration attempts; it does not alter these graph limits. A new OMP process is required to load this source; an already-running process keeps its loaded guards and does not gain them retroactively.

Use the task-graph tests only in the dedicated lab root, with the marker and environment variable below. They use mock model execution, real Git fixtures, an isolated SQLite database, and two independent processes; they are method checks, not product acceptance, real parallel delivery, or an assertion of automatic merge behavior. `task-graph-recovery.test.ts` covers the controller-simulated interrupted-author `task_reconcile`/`task_claim_reconcile` route and unspawned-claim cancellation, including invalid proof and changed/dirty rejection. It does not run a real model, kill real child processes, or prove real external side-effect inspection.

```powershell
$env:OMP_EXPERIMENT_ROOT='D:/Labs/omp/omp-merge-lab-20260918'
bun test tests/task-graph.test.ts
bun test tests/task-graph-recovery.test.ts
```

To roll back this feature, first settle every graph node with its evidence preserved. Then restore the controller extension, imported library, and these task-graph/worktree/rule/decision/upgrade documents together from the reviewed change. Preserve the control DB, branches, worktrees, receipts and other evidence; do not delete or edit the DB to simulate a rollback.
