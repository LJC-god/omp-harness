---
description: On-demand procedure for complex/high-risk controlled runs; all CODING artifact authorship follows assigned native or controlled routes in main-agent-orchestrator
---

# CODING execution procedure

Read this document as instructions; it is not an executable slash workflow. Required before starting or recovering a controlled run and after relevant configuration changes. Assigned native work and its read-only activity lookup follow main-agent-orchestrator and do not load this procedure. DAILY does not load it. Global main-agent-orchestrator and harness-router rules still apply. Tool implementations enforce their own boundaries; ordinary child filesystem tools remain cooperative, not an OS sandbox.

## Dispatch quality

- Ordinary project writers: one assigned writer per file or tightly coupled set of files. Acquire `lease_acquire` on that path before dispatch; the controlling session owns the lease and `project_spawn` maintains it while the child runs. Release it after the writer yields.
- Cross-agent shared files and critical control files: not single-writer. Use `omp_control` `safe_write` with `baseSha` plus a live lease fence. Ordinary product files stay single-owner and MUST NOT go through `safe_write`.
- Assignment states target, change, acceptance, and what not to touch. All implementation assignments include the author-check/evidence contract from frontend-workflow.md when frontend, or verification-evidence.md otherwise; controlled dispatch is not an exception. The initial author owns focused self-check repairs and development-time visual-feedback corrections within its paths, not a sequence of new tasks for each missing import. A confirmed final-review defect transfers only after that writer settles, to repair-worker with a new bounded root-cause assignment under the existing fences.
- Wait for results before claiming done. Do not invent outcomes.
- For multiple requirements, attach a short requirement-to-evidence map to the existing assignment/checkpoint and verify real changed behavior on the current candidate. Use existing output schema evidence fields and the mandatory parent product reviews from verification-evidence.md; no extra acceptance tool or user approval round. Use task_observe for bounded waits and repeatable terminal result retrieval. A checkpoint never substitutes for task receipts or run_complete.

New-project preparation and destination conflicts use ~/.omp/agent/notes/workspace-lifecycle.md. Model/module ownership is in main-agent-orchestrator; every controlled artifact write belongs to its assigned author, while Sol coordinates and retains non-author Git/checkpoint duties. UI acceptance uses ~/.omp/agent/notes/frontend-workflow.md. For new workflow policy read ~/.omp/agent/notes/workflow-baseline-v1-20260921.md: a failed or uncertain execution pauses new dispatch, and only Sol can explicitly resume proven independent work after inspection. These references do not relax this run's frozen contracts or fencing.

## Project workspace on D; OMP system state on C

No official OMP unified `data.root` / `storage.root`. Do not invent config keys. Do not relocate the whole OMP agent dir to D.

Project source, worktrees, project build artifacts, and project evidence MUST live on D: — the project root on D: or under `D:/OMPData` (see `D:/OMPData/storage.manifest.json`). Layout on D: `worktrees`, `projects`, `archives`, `github`, `registry`. Official key in use: `worktree.base` = `D:/OMPData/worktrees`.

New project roots MUST be on D:. If the user asks to create or use a project root on C:, ASK / BLOCK first. Do not silently create C: project roots.

OMP system state stays on C at official defaults under `~/.omp`: config, sessions, logs, `agent.db`, credentials, internal blobs (`~/.omp/agent/blobs`). Do not set `PI_CODING_AGENT_DIR` to D. Do not move config/sessions/logs/agent.db/credentials/internal system data to D. Do not treat `D:/OMPData` as a unified OMP heavy-data root.

If D: is unavailable or free space is insufficient, ASK the user. NEVER silently fall back to C. Do not create junctions. Do not migrate or delete existing C: OMP data.

CODING enforcement of this boundary is the control plane below. Control DB stays on C at `~/.omp/agent/orchestration.sqlite`. NEVER copy the C DB, WAL, or SHM to D.

## CODING control plane

DAILY MUST NOT use this plane. Do not paste the JSON contracts into prompts. Call the tools. Do not change `maxConcurrency`, model routes, or the user's technical stack. `maxConcurrency=0` means unlimited, not serial execution: serialize overlapping project writes; independent read-only reviews may run concurrently. Shared Web research follows harness-router: quick retrieval by default, parallel sources when cross-checking is useful.

| Tool | Extension | Role |
| --- | --- | --- |
| `omp_control` | `~/.omp/agent/extensions/omp-control.ts` | health, register/get, run, baseline, lease, generation, spawn, safe_write, event_append, outbox |
| `omp_archive` | `~/.omp/agent/extensions/run-archiver.ts` | prepare, verify, publish, status |
| risk contract | `D:/OMPData/registry/risk-redblue-contract.json` | red/blue staffing and block rules |

Order for a controlled run (not routine assigned native work):

1. Fail closed
2. Establish the local Git baseline using main-agent-orchestrator first; then start gate: `project_register` or `project_get` → `run_begin` → `baseline_capture` → `generation_get`. The control snapshot does not replace Git history. Commit each completed verified implementation step under the existing writer/index ownership before its final candidate review; do not postpone all commits until run completion or invalidate a review's HEAD and reuse its PASS.
3. `lease_acquire` on each owned write path
4. `project_spawn` with strict output schema
5. Risk staffing from the JSON contract
6. Local archive prepare/verify when available; publish only through an authorized binding after verification

### Fail closed

Before the first CODING spawn:

1. `omp_control` MUST be registered; archive availability is checked separately at archive time. `health` is the only anonymous action (no session). Probe `omp_control` `health`; `ok` means WAL, `synchronous=FULL`, and `foreign_keys`. The health payload MUST NOT include an absolute path (`storageClass` / `schema` only). DB ACL and schema bootstrap run only from the trusted extension init or test adapter. Public actions MUST NOT migrate schema or rewrite DACL. Internal `withInitializedPreauth` MUST NOT be selected by a public action, tool argument, or env path, and MUST NOT bootstrap.
2. Project identity is one D: Git working tree. D: linked worktrees are allowed when both `git_dir` and `git_common` stay on D:. The tool pins `root_vol` / `root_index`, `git_dir` volume+fileId, and `git_common` volume+fileId. Missing pins are `NOT_MIGRATED`. No `allowedRoots`. No `additionalDirectories` as a working root. Registered project roots MUST NOT be ancestor or descendant of each other. Static reserved D infrastructure MUST NOT be registered: `D:/OMPData/registry`, `D:/OMPData/archives`, `D:/OMPData/github`, and the `D:/OMPData/projects` / `D:/OMPData/worktrees` containers (`RESERVED`). Legal worktree root: only a single direct child of `D:/OMPData/worktrees` (no nested path). A `D:/projects` Git root is allowed. `CONFLICT` returns only an id, never a path. `C_PROJECT_ROOT`, `NOT_D_ROOT`, `JUNCTION`, `PATH_ESCAPE`, `NOT_FOUND`, `NOT_REGISTERED`, `NOT_GIT`, `NOT_GIT_ROOT`, `ROOT_IDENTITY`, `ROOT_MOVED`, `GIT_IDENTITY`, `NOT_MIGRATED`, `RESERVED`, `CONFLICT`, `SESSION_REQUIRED`, `QUARANTINE`, `OWNER_MISMATCH`, `RUN_OWNER_MISMATCH`, `ROOT_MISMATCH`, `ROOT_CONTEXT_REQUIRED`, `RUN_REQUIRED`, `UNSETTLED_TASK`, `FILE_TOO_LARGE` are hard stops. ASK/BLOCK a C: project root; do not register it.
3. Session/run ownership: stable session required for non-health actions. `projects.owner` is historical creator metadata, not a permanent project lock; `nosession` remains quarantined. `/new` in the same canonical root may get/re-register the project and begin a new run. `runs.owner` authorizes task receipts, reconciliation, events, queue delivery and archive operations. Explicit foreign run access fails `RUN_OWNER_MISMATCH` during readonly preauth. Run-scoped operations require explicit `runId`; omission is `RUN_REQUIRED`, never latest-run inference. Leases and heartbeat renewal belong to that run even when two runs share one session. Legacy unbound leases must expire. Do not mutate old runs or forge session IDs. Archive public/lifecycle paths check project validity and run/session binding before FS/Git/schema work. Only trusted init migrates the additive schema. Do not hot-reload control extensions while their tasks are active. This backward-compatible workflow update needs no DB migration: newly launched OMP processes load it; existing processes retain their loaded code until a normal restart. Never require closing unrelated sessions as task recovery.

Any control identity/ownership/fencing miss: stop affected writes. No inherited-cwd spawn, unregistered controlled root, unfenced controlled write, or alternate `task` path to bypass a live controlled run. Archive limitations are handled separately below.

### Production smoke isolation

User CODING runs use `~/.omp/agent/orchestration.sqlite` and the registered project root only.

`D:/OMPData/registry/omp-control/smoke.ts` and `D:/OMPData/registry/run-archiver/smoke.ts` are isolated gates. They MUST use a random `D:/OMPData/worktrees/<leaf>` fixture and an isolated sqlite (temp `omp-ctl-*.sqlite` or `D:/OMPData/registry/run-archiver/smoke.sqlite`). NEVER the production control DB. NEVER a user project root. NEVER live GitHub. NEVER `gh repo create`. Create each fixture via the parent handle with relative `FILE_CREATE`, then immediately hold a deny-delete/rename handle. The random marker is handle-relative. At runtime both smokes MUST NOT auto `delete` / `rmdir` / `unlink` or recursive-purge. `fail` throws. The complete `main` `finally` MUST print every tracked RUN residue as path + marker + vol/fileId before any failed exit, then exit nonzero. Cleanup after process exit is a separate authorized step. Control/archive smoke and production work MUST NOT use pathname recursive `rm`. Production cleanup is handle-relative identity only. NEVER prefix-scan the registry or archives container.

Sol MUST NOT run those smokes as a user-run step, and MUST NOT point them at the live control DB or a live archive remote.

### Start gate

Do not spawn writers before this completes, in this order:

1. `project_register` or `project_get` — only `canonicalRoot` (D: Git toplevel, including a D: linked worktree). Requires a stable session (`SESSION_REQUIRED` if missing or `nosession`). Lexical reserved/nest checks run before materialize; the canonical path is rechecked inside the register txn. Nested ancestor/descendant of an existing project is `CONFLICT` (id only, never a path). First register records creator metadata: one atomic insert of `projectId`, `owner=session`, `root_vol` / `root_index`, `git_dir` + volume+fileId, and `git_common` + volume+fileId. Later get / re-register / all other public actions pin those identities before further work. Missing pins are `NOT_MIGRATED`. `projectId` is opaque lowercase `^[a-z0-9][a-z0-9._-]{0,63}$` (omit to let the tool mint one; a caller-supplied id MUST match). Keep `projectId`. Stored ids that fail the charset, or `owner=nosession`, are `QUARANTINE`.
2. `run_begin` — bind this run to that root. Set `risk: mechanical|standard|high` using the risk contract before dispatch (default standard). This freezes required review slots for this run: mechanical = verification; standard = verification + security; high adds data_loss, critical_production_failure and reproduction. Arbitration is optional unless explicitly dispatched for an actual disagreement; then its current-generation receipt is required. New eligible integration runs may instead declare `executionPolicy: "integration-v1"` with a frozen argv `checkCommand`; its sole required gate is `integration_check`, which the root records through `run_check` using an idempotency key. High-risk work rejects this policy. Existing omitted-policy and frozen contracts are unchanged. Classification is a coordinator decision, not inferred from an agent name; never downgrade a run to avoid gates. The tool mints `runId`; keep it and the returned `requiredGates`. Recorded cwd is the canonical root.
3. `baseline_capture` — `canonicalRoot/.omp/baseline.json` on D:.
4. `generation_get` — this run's generation. Findings, evidence, and gate results MUST carry it.

For a NEW task after `/new`, reuse the project and call `run_begin` in the new session; the existence of old conversation history is not a blocker. `/omp-resume-project [projectId]` is OPTIONAL and only resumes the original creator conversation. To continue another historical run, resume that run's actual owning session. Missing old history blocks recovery of that old run, not creation of a new run. Never edit the DB or fake an owner. `UNSETTLED_TASK` blocks potentially conflicting writes until the old task is reconciled; lease expiry alone is not proof that its process stopped. Read-only review may proceed in a new run. Preserve all pending receipts.

### Spawn

- CODING children only via `omp_control` `project_spawn`. Fields: `projectId`, the recorded `runId`, `agent`, `task`, `outputSchema`. cwd is bound inside that action to the pinned canonical root. NEVER pass `cwd`, `command`, `argv`, `allowedRoots`, `additionalDirectories`, or `schemaMode`.
- `agent` MUST be on the CODING allowlist (harness-router). Use `fast-worker` only for mechanical work; use the module/role routing in main-agent-orchestrator (`frontend-worker` for UI, `sonic` for bounded ordinary logic, `task` for complex logic). Existing frozen assignments keep their original scope and model constraints. Project-local agent shadows are `AGENT_SHADOW`; unknown names are `AGENT_NOT_ALLOWED` / `AGENT_NOT_FOUND`.
- `outputSchema` is required and a strict closed dialect allowlist: JSON Schema `type` object/array/string/number/integer/boolean/null with only the allowed keys, or JTD `type` / `enum` / `elements` / `properties`+`optionalProperties`. Extra keys, `additionalProperties: true`, empty objects, array schema roots, and unconstrained types are `INVALID`. The tool sets `outputSchemaMode` strict internally. Reject yields that fail the schema. Do not use `task` just to set a schema.
- Isolate by `projectId` / `runId` / generation. Do not mix generations across children or reviews. The tool holds root / `git_dir` / `git_common` handles for the whole child lifetime and post-verifies those identities after the child returns. Drift is `ROOT_IDENTITY` / `GIT_IDENTITY`.
- Spawn resolves global/project settings and centralized agent overrides through the installed executor. Caller cancellation and progress are forwarded. A failed, errored, or aborted child is not success; inspect `ok`, tool error, and the retained executor result. Runtime-only settings not exposed by ExtensionContext cannot be inferred from persisted settings.
- `project_spawn` is root-session only: the registered tool rejects task sessions identified by the installed runtime's `session_init` marker. Children cannot bypass the no-recursion policy by invoking this control tool instead of task.

### Task receipts and interruptions

- Every spawn assignment supplies a stable `idempotencyKey` and the recorded `runId`. Reusing the same key and exact request returns its receipt without executing again; changed arguments/generation with the same key are `TASK_CONFLICT`. A genuinely new assignment needs a new key.
- `task_get` with `projectId` and `idempotencyKey` retrieves the receipt. With `runId` instead, it lists recent tasks. The executor session is retained under the official C: session storage; the receipt retains bounded structured completion rather than duplicating the transcript.
- A queued question, skipped tool result, peer message or missing hub session does NOT prove that execution never started. Check the receipt first. `running` may mean active or interrupted by a process crash; `interrupted` means side effects are uncertain. Neither is retry-safe. Do not switch keys to bypass this uncertainty. Inspect the retained session and actual state, then return a recovery decision to the user if execution/side effects cannot be established.
- `project_spawn` injects exact runId, taskId, attemptId, contractVersion, generation and controllerPid. Workers use these values without rediscovering them. Ask workers to report evidence to the parent, not invoke root-session project control actions. Supply root health, generation and scope in the initial assignment. Resolve peer requests through hub; do not repeatedly replace the whole review task.
- Status questions should receive the current task ID/state and recent progress, not an unsupported assertion that no work happened. Explicit user cancellation remains authoritative; never suppress it to keep a task running.
- After interruption, a separate read-only verifier can reconcile the retained session, actual paths and process state. Its strict result must include PASS, generation, runId, empty findings, non-empty evidence, `reconcilesTaskKey`, `processesStopped:true`, and `sideEffectsKnown:true`. The verifier receipt must retain a source fingerprint that still matches the project when `task_reconcile` runs; stale or legacy evidence needs a fresh verifier. Then `task_reconcile` with the original `idempotencyKey` and that verifier's `evidenceTaskKey` atomically settles the uncertain receipt as failed and records recovery, never success. Active in-process tasks cannot be reconciled. The receipt PID is the controller PID, not a worker PID. A live host does not block reconciliation after its executor returned; concrete proof that task-owned shell children stopped and side effects are known remains required. Advance generation, use a new key for any remaining work, and rerun final gates. Missing reconciliation proof remains BLOCK; do not simply overwrite task state.

Choose the next action from the actual receipt before dispatching another task:

| Observed state | Next action |
| --- | --- |
| No receipt created; argument validation rejected the call | Correct the named field using the installed interface; do not advance generation or change the key merely to retry. |
| succeeded | Reuse its result after checking source/coverage; unfinished acceptance is not automatically executor failure. |
| failed, execution returned | Inspect side effects and current run_status; settle any separate uncertain task, then advance once under the required wildcard lease before replacement work/reviews. No recovery verifier solely for an already-settled failure. |
| interrupted or running with uncertain execution | Inspect the retained session and identified task-owned processes, then use the evidence-backed reconciliation below; never infer stopped from elapsed time or controller PID. |

For a strict-output rejection that created a failed receipt, first distinguish it from an INVALID call that created no task. The current controller counts every current-generation failed task: a same-generation replacement PASS cannot clear it. Once execution is settled and side effects are known, correct the output contract and advance before commissioning replacement gates; carry forward valid inspection evidence as context, while every frozen required gate still needs a current-generation/current-source receipt. Do not patch product source for a formatting-only error, change an old receipt, or add a schema-debug task that repeats the full audit. Use task_get/run_status to confirm which condition actually blocks completion.

Prepare recovery evidence before spawning its verifier: original task_get receipt and key, exact run/generation, retained transcript, landed paths, task-owned process evidence and a closed outputSchema containing ALL reconciliation fields. Add the compact repair/recovery handoff from `~/.omp/agent/notes/verification-evidence.md` so the receiver has the prior failure, corresponding repair and pending checks. The recovery verifier assesses whether continuation is safe, not whether unfinished product acceptance passes. Missing proof stays BLOCKED. If a receipt is rejected for formatting, correct that exact field/schema and reuse the inspection evidence after checking it is still current; do not request a fresh full product audit. Never fabricate processesStopped/sideEffectsKnown to satisfy the schema.

Before that recovery dispatch, check the requested closed object schema against these existing fields (this does not change the native schema): `status` permits PASS/FAIL/BLOCKED/INCONCLUSIVE; `generation`, `runId`, and `reconcilesTaskKey` are required strings; `findings` uses the existing structured finding array; `evidence` is a required array of nonempty strings; `processesStopped` and `sideEffectsKnown` are required booleans. Put all eight fields in both properties and required, with additionalProperties false. Use the supported type/enum dialect; const is not accepted, and generation must not be numeric. Do not constrain status to PASS or either boolean to true: the verifier must be able to report missing proof honestly. Only a valid PASS with empty findings, nonempty evidence and both booleans true can authorize task_reconcile. Supply the interrupted task's key, not the verifier key, as reconcilesTaskKey; task_reconcile.evidenceTaskKey names the successful verifier receipt. Use the injected current generation as a string and the original runId. This recovery schema does not replace ordinary review schemas.

For native control calls, read the actual tool interface once and reuse successful arguments. generation_advance needs the live wildcard lease's `token`; lease_release needs its exact `resource` and matching `token`; root/run identifiers remain explicit. Release the settled writer's path leases before Sol's Git mutation, without dropping fences for active writers. On INVALID, inspect the named field before retrying; never guess leaseToken, omit runId, invent query-string tool URLs, or append line ranges to filesystem paths. Keep the working recipe in the current handoff, without copying live tokens into durable memory.

### Recovery without unnecessary user interruption

Read `task_get` before choosing recovery. `succeeded` reuses the result. `failed` is already settled: inspect actual changed paths and any task-owned processes, advance generation under a lease, and finish remaining work without rerunning successful side effects. Do not ask for `/omp-recover-task` on an ordinary failed receipt; the command returns an already-settled result without confirmation. A legacy aborted-but-failed receipt may also be reconciled with verifier evidence.

`interrupted` or orphaned `running` requires the evidence-backed `task_reconcile` path above. Timeout/abort is recorded as interrupted. For the current runtime, the active task registry distinguishes a running executor from one that has returned. The stored PID is only the OMP controller; never instruct `taskkill /PID <controllerPid> /T /F` or closing the whole conversation solely because it is alive. Inspect/cancel only positively identified task-owned workers, preserve their output, and verify they stopped. Never kill an unknown process.

A different live runtime remains protected: coordinate with that task's owner rather than taking it over. If task ownership or side effects cannot be established automatically, explain the concrete unresolved conflict. The user-only `/omp-recover-task <projectId> <taskKey>` remains a last resort for orphaned running/interrupted tasks; it checks ownership, active execution, leases and explicit evidence. Neither a user's selection alone nor elapsed time proves worker termination. Never edit the DB or forge run identity.

### Completion receipts

Review spawns specify the corresponding `gate` from `requiredGates`, or `arbitration` when an actual disagreement requires it. Roles are enforced: verification/reproduction use verifier, the three red slots use security-reviewer, arbitration uses reviewer. The strict output schema wraps the existing finding schema in `{ status, generation, runId, findings, evidence }`: status PASS/FAIL/BLOCKED/INCONCLUSIVE, generation is String(control generation), runId is the assigned run, findings is an array of contract findings, evidence is a non-empty array of concrete references. Never substitute strings for structured findings.

After all writes and generation advancement, run the required reviews against final source. Then call `run_complete`. It returns `ok:false` until current-generation required receipts pass and match the tool-recorded source fingerprint, no task is unsettled/failed, and no blocking finding remains. `staleGates` lists reviews needing current-source evidence; repeat those reviews, not the implementation. A later generation invalidates prior reviews. A later PASS does not erase an earlier blocking finding on the same generation. Old runs without frozen contracts are UNASSESSED; old receipts without source fingerprints remain historical evidence.

This gate checks recorded evidence, not the filesystem sandbox or truthfulness of a review. UI screenshot/user-direction requirements remain additional manual gates and must not be inferred from `run_complete`.

### Write path

Before dispatching a write assignment: `lease_acquire` with `projectId` and `resource` = owned path (or a tight prefix); keep its returned token. There is no public `owner` input: ownership comes from the controlling session. Record the assigned child separately in the task contract. `LEASE_HELD` → wait or reassign; do not overlap writers on the same resource.

- Ordinary project files: single owner + lease. The child writes with its own tools.
- Shared / critical control files: `safe_write` only (`baseSha` + live lease fence; preimage under `canonicalRoot/.omp/blobs`). `BASE_SHA_CONFLICT` / `STALE_FENCE` → stop; do not clobber. On `openRelDir` failure, release every owned handle in reverse order.

`project_spawn` automatically renews only the session's live leases captured at launch. Released, expired, replaced, or wrong-generation fences cancel the child; cancellation is cooperative, not an OS filesystem sandbox. Outside spawn, explicitly renew a lease before it expires. After yield, `lease_release` each path with its matching token. After a mutating fix, acquire the project-wide `resource: "*"` lease once path leases are released; pass that token to `generation_advance`. Advancement consumes the wildcard lease and invalidates prior evidence. Never advance while a writer is running.

### Messages and outbox

Durable control messages use a stable id. `outbox_enqueue` is idempotent: same id + same payload is a duplicate; same id + different payload is `OUTBOX_CONFLICT` (fail closed). Drain and ack only claimed items. Persist and return `payloadSha` only. Legacy rows that still carry a payload are rehashed then stored as `quarantine`; drain skips them, ack is `NOT_MIGRATED`. Archive outbox id is `archive.` + sha256(`projectId` + NUL + `runId`) — the archiver owns that key. Archive outbox enqueue/drain/ack MUST call `dispatchAt(archiveDbPath())` bound to the production C DB (`~/.omp/agent/orchestration.sqlite`) or the test-isolated DB. NEVER implicit global `dispatch` or a test-only path. Archive `status` binds outbox by (`project_id`, `id`).

### Risk

Follow `D:/OMPData/registry/risk-redblue-contract.json` `solSteps` and `triggers` by precedence. Controller gate roles remain: mechanical and blue = `verifier`, red = `security-reviewer`, arbiter = `reviewer`. Purple is a separate native parent product review, not a new controller gate. The tiers below govern controlled run gates; every new complete product additionally requires red, blue and purple at parent delivery even when a child run is mechanical/LOW. Preserve each frozen run's requiredGates.

1. Mechanical small (LOW, no control flow, no public API, no auth/secrets/db/payment, no new dependency, not security-tagged) → `verifier` only.
2. Concrete high risk (HIGH/CRITICAL with evidenced security, production or irreversible data impact) → red 3 + blue 2; one red agent per red type (`security`, `data_loss`, `critical_production_failure`). Add arbitration only for actual disagreement. Git, Docker, CI, public API or cross-package labels alone do not establish high risk.
3. Else non-trivial → red 1 + blue 1.

Same generation across red, blue, and arbiter. Finding JSON encodes generation as a string (String of the control generation, or the exact frozen configuration hash); compare the same canonical encoding. Command exitCode is an integer; omit it when no command ran. Schema or generation mismatch → REJECT. Blue reproduces every P0/P1. Arbiter only on high-risk disagreement; arbiter MUST NOT patch or invent findings. P0/P1 with valid evidence block acceptance and transfer a bounded repair to repair-worker after the assigned writer settles, then `generation_advance`, invalidate, and rerun required reviews on the new candidate. A failed first repair is not automatically a user decision: Sol inspects new evidence and chooses a bounded repair or a different diagnosis within existing authorization. Do not repeat an unchanged failed attempt; involve the user only for a missing consequential choice, authorization, or an external blocker that cannot be resolved locally. Preserve frozen contracts and never waive a valid blocking finding to finish. No evidence → NO_BLOCK. A title that says "security" is not P0. `not_run` alone MUST NOT BLOCK P0/P1.

Keep reviews convergent. The first review covers the changed behavior and its shared trust/data boundaries. Follow-ups recheck reported findings, the repair diff and affected callers; attach prior coverage as context, not as a current PASS. A new generation still needs every frozen required gate on the current fingerprint. Do not ask every follow-up to rediscover the entire application unless a newly evidenced dependency warrants it. Independent read-only reviews may run concurrently using supported native execution; sequential blocking calls are not parallel merely because the prompt says so.

In each review brief, request that findings identify whether they are introduced by this change, newly exposed by it, or pre-existing and independent, with a concrete trigger and evidence. Use the finding-disposition guidance in `~/.omp/agent/notes/verification-evidence.md` in the existing evidence record; keep the strict receipt schema unchanged. Sol checks disputed acceptance against the user's intended behavior (for example live orphan documents versus legitimate deletion tombstones) before commissioning a source patch; native blockers and required arbitration still apply.

After two repair rounds reveal the same boundary again, Sol pauses further patch dispatch to trace its shared lifecycle/callers and revise the existing implementation plan. Collect the related confirmed findings into one coherent repair, with failure/race checks and author ownership. Then continue under existing authorization and fences. This is a diagnosis trigger, not a two-round limit on fixing real defects, a timeout increase or another approval flow.

Red, blue, and arbiter MUST NOT patch. Frontend visual verification follows the single GPT review and relevant-viewport policy above.

### Archive close

For controlled-run archive operations read ~/.omp/agent/notes/archive-procedure.md. Archive transport is separate from task completion; only an authorized private binding permits publication.
