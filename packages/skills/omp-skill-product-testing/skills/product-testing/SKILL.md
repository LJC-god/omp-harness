---
name: product-testing
description: Plan and run narrow, durable regression checks for critical product persistence, authentication, and browser interaction paths. Use after a product foundation exists; it complements Matt testing and diagnosis methods and does not create a new test framework.
---

# Product testing

Use this only to make a critical persistent behavior reproducible and reviewable. Matt `tdd` remains the primary method for a confirmed test seam; Matt `diagnosing-bugs` remains the primary method for a difficult failure. This method selects the real product path, records its evidence, and keeps runtime state isolated.

## Choose the smallest real path

After the shared foundation is verified, exercise one early journey that crosses the risky boundaries: login, create, edit, reload, and confirm the saved result where required. Reassess whether its stable contracts and fixtures permit up to four independent authors; Sol assigns one writing owner for shared manifests, lockfiles, and contracts. Update the existing task table with actual author, source/commit, check, result, and evidence receipt before final review.

Keep reusable regression source and deterministic assertions with the product. Put per-run databases, fixtures, credentials, service logs, browser traces, screenshots, and other runtime output in a new unique directory below `$OMP_DATA_ROOT`（由 harness 环境变量指定的数据根，下面再建唯一的运行目录）, outside product source. Quote every absolute path in commands and records. Do not add a Python/JavaScript E2E framework, downloaded dependency, scheduler, or helper merely to organize evidence.

## Cover the critical regression class

Use real isolated runtime services and data when the risk is database concurrency, transaction rollback, or authorization. Assert the observable result and the relevant persisted state; inspect service logs or application state when they explain a failure. A task-owned isolated running database is allowed; never use a user or production database, account, or credential. A rollback check must prove both the failure result and the retained/removed state that defines rollback.

For browser behavior, keep the existing verified browser driver and follow `~/.omp/agent/notes/browser-verification.md`. Use real input for the requested interaction, then assert the relevant negative path and focus behavior as well as the successful state. Reload when persistence is part of the claim. Synthetic DOM events, direct storage writes, and screenshots without the final state are diagnostic evidence only.

## Ownership and evidence

Sol selects the relevant coverage from the accepted behavior: pure logic/unit checks, API and real-database integration, browser user journeys, and required security/accessibility review. The existing project framework and pinned commands determine execution. Do not install a collection of overlapping testing skills or add mandatory planner/generator/healer agents. Reuse this skill, the existing Matt method and browser-verification.md; read only the method needed for the current failure or test boundary.

For generated browser tests, retain concrete user steps and expected outcomes, isolated fixtures, user-facing locators and retrying assertions. Distinguish a broken product from a stale selector, flaky environment or incorrect test expectation before repair. No automatic healer may skip a failing required test, weaken its assertion, substitute direct state mutation for real input, or rewrite expected behavior merely to turn the suite green. A confirmed product or test defect transfers with its original failure evidence and intended behavior to repair-worker after the prior writer settles. The reviewer independently confirms closure.

Method sources checked for this integration: https://playwright.dev/docs/best-practices and https://playwright.dev/docs/test-agents. The upstream planner/generator/healer split is a reference, not a new OMP role chain; independent acceptance and Terra repair ownership remain authoritative.

Before a review begins, assign one test author for each source/test change and one runtime owner for each run. The runtime owner alone starts, rebuilds, restarts, or stops that run's services. Reviewers are read-only: they cannot modify source or tests, and they cannot delete another reviewer's output. Test authorship does not transfer during review.

For each completed run retain a small receipt containing the source/commit, exact command, runtime owner, isolated data identity, result, and absolute paths to the final trace/state/log or screenshot. Before reporting completion, use existing tools to verify for every retained reference: the literal path exists, is nonempty, and belongs to the verified current run. Reviewer artifacts within that run are valid and protected; do not include shared-cleanup artifacts. Record that verification with the receipt. Remove only explicitly named temporary artifacts owned by the current run after that check; retain shared and reviewer evidence.

If a check confirms a product defect, hand the bounded repair and its receipt to `repair-worker` (`@repair=Terra:high`), the separate write identity. The original author supplies context and stops writing that transferred scope. `repair-worker` does not independently approve its own result; final acceptance stays with the required independent gate.
