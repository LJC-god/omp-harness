# Opt-in task-graph merge queue

Use this phase only after `task-graph.md` has recorded a `delivered` node. It serializes the integration of that node through one queue entry, one real candidate worktree, and the real target root. It does not create, move, dispatch, clean, or delete a worktree; a model assignment never moves a root session. Sol explicitly moves each settled root session and verifies its cwd before the corresponding control action.

The queue is an `omp_control` protocol, not an authorization to merge. It preserves the delivered branch and the candidate as evidence, and product acceptance remains a separate target-root decision.

## Enqueue a delivered node

From the registered target root and its current owning run, call `merge_enqueue` with `graphId`, `taskId`, and a new `idempotencyKey`; that key identifies this attempt. The graph must target this project/ref and the node must be `delivered`. The queue records that node's exact `delivered_head`, target project/run/owner/generation/common Git directory/ref, and returns the queued attempt and `claimToken`. The numeric database queue id is internal; every later call uses graph, task, attempt key, and token.

The same active key is idempotent. A `blocked` or `cancelled` attempt is evidence, not a retry slot: inspect it and enqueue a distinct explicit key for a new attempt.

## Prepare and verify the real candidate

`merge_prepare` runs only from a distinct, registered, clean candidate worktree with its own running run. Supply `graphId`, `taskId`, `idempotencyKey`, and the returned `claimToken`. The attempt must be the FIFO head for its common Git directory and target ref. Preparation takes the one common-directory integration lock, records the target base and candidate identity/branch/HEAD, and merges the stored delivered SHA into the candidate as an internal no-fast-forward merge. The exact recorded parents/base and delivered SHA produce `candidate_ready`; any conflict, mismatched identity, dirty state, or uncertain operation produces `blocked` and retains the lock.

If the delivered commit is already in the target during preparation, the attempt reports `state: "merged"` with `alreadyIntegrated: true`; no candidate verification or application follows. Otherwise, run `merge_verify` only from that recorded candidate project/run, with the same identifiers and token. It requires the exact clean candidate HEAD and that an `integration-v1` candidate's frozen `integration_check` through root `run_check`, or its legacy required gates, are complete for the candidate's current source. It records the candidate fingerprint and generation and changes the attempt to `verified`. Those candidate checks do not transfer to the target project or complete its product checkpoint.

## Apply only at the real target root

`merge_apply` runs only from the exact target project/run/owner/generation frozen at enqueue, with the same identifiers and token. It requires a clean target on the recorded ref and base, the pinned exact candidate head, current candidate fingerprint/gates rechecked immediately before the fast-forward, and recorded ancestry. It fast-forwards the target internally. Only an exact target HEAD equal to the candidate HEAD is `merged`, and only then is the integration lock released.

No post-fast-forward target-root gate or product-checkpoint action is part of this queue. Where the delivery workflow requires them, evaluate target-root gates and the target product checkpoint separately against the target's current source. Candidate verification establishes queue eligibility only; it neither reuses a receipt across roots nor declares the target product complete.

## Status, uncertainty, and repair

`merge_status` may be called from a registered project in the same common Git directory to inspect attempts and the integration lock. The state sequence is `queued`, `preparing`, `candidate_ready`, `verified`, `applying`, then `merged`; uncertainty may lead to `blocked`, and an explicit cancellation leads to `cancelled`.

For a lost response or uncertainty, use `merge_reconcile` from the frozen target context with the same identifiers and token. It never retries a Git operation: it can recognize an exact completed candidate preparation or target application from Git facts, otherwise it leaves the attempt `blocked` and preserves the lock. Do not reset, abort, force, clean, or remove a candidate/worktree to make the queue advance.

A phase owned by this runtime may reconcile only after its local operation is no longer active, using the exact target/candidate SHA inspection. A foreign runtime whose recorded host PID is dead is still not proof that its Git worker, hooks, or side effects stopped. If that foreign host is alive, reconciliation is `TASK_ACTIVE`. If it is no longer alive, provide `evidenceTaskKey` for a successful target-project `verifier` receipt under the frozen target run and generation. Its current-source fingerprint must equal the target root's current fingerprint and its strict PASS data must name the graph, task, and attempt; report `processesStopped: true`, `sideEffectsKnown: true`, the inspected target and candidate HEADs, the candidate source fingerprint, no findings, and nonempty evidence. The controller re-pins and compares the candidate branch, HEAD, fingerprint, current run/generation, and every proof field. Missing, stale, wrong, or incomplete evidence is rejected without changing the attempt or releasing its lock.

Cancellation uses `merge_reconcile` with `cancel: true` only for a `queued` attempt or an already `blocked` attempt whose operation fields have been cleared. It does not require a new verifier proof for an ordinary settled blocked attempt. Cancellation releases the lock but retains the target, candidate, branches, receipts, and evidence. Requeue only with a deliberate new `merge_enqueue` idempotency key after inspection; there is no automatic retry, reset, cleanup, or cross-root model dispatch.

## Limits, rollout, and evidence

The lock serializes one integration across all refs in a shared common Git directory; it does not provide operating-system isolation or semantic conflict resolution. A new OMP process loads this controller behavior. Already-running OMP processes retain their loaded extensions and do not gain this protection retroactively.

Run any isolated experiments only under `D:/Labs/omp/omp-merge-lab-20260918` with `OMP_EXPERIMENT_ROOT` and the `omp-dependency-lab/v1` marker. The captured Stage 4 controller suite is `D:/Labs/omp/omp-merge-lab-20260918/merge-queue-tests.log`: `bun test tests/merge-queue.test.ts tests/merge-queue-recovery.test.ts tests/task-graph.test.ts tests/task-graph-recovery.test.ts tests/worktree-workflow.test.ts` exited 0 with 5 passing tests and 163 assertions. It uses mock execution with real Git worktrees and isolated SQLite, covering FIFO/CAS admission, candidate and target pins, stale-target blocking, conflict preservation, cancellation, and foreign-runtime recovery evidence.

One Stage 5 fixture completed at `D:/Labs/omp/omp-merge-lab-20260918/pilot-stage5/attempts/1a0ab2a6-5459-482d-a42c-4dd168d24368`. Its immutable fixture test tree stayed at `cc213d115d6b053eab3a43fc32ce4774fdb649525a96d90c876fb4cc71d14f4f`; two disjoint authors overlapped for 25,198 ms, delivered their commits, and two real candidate attempts merged in FIFO order to target `37c3a30f69e1333dc9c9637dc8d4f0680244d4f8`. `completed.json`, seven original worker command records, `model-evidence.json`, `controller.sqlite`, `root-independent-verification.json`, and `root-acceptance.log` record 23 successful `openai-codex/gpt-5.6-terra:high` provider requests, target `taskComplete: true`, no remaining integration lock, clean target/authors, and a direct target `bun test` result of 3 pass. The temporary overlay applied only to this runner; it does not change global routing. Reported token and cost fields are runtime estimates, not a provider bill.

The first armed attempt `c4418774-fbc4-4a26-b2d9-2b02e92e76ec` stopped before any model request because a lazy session file was unavailable; it remains retained as failure evidence. This one bounded fixture does not prove product acceptance, broader concurrency behavior, real process killing, external side-effect inspection, or lost-operation reconciliation in a real model run.
