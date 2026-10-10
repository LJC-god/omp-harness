---
description: Bounded inventory-first maintenance of explicitly authorized OMP test residues
---

# Test-residue maintenance

This is pure filesystem maintenance, not a product change. Keep HARNESS: DAILY only while no source, configuration, credentials, production DB, registry or archive content is changed. Do not register the current unrelated project, capture a project baseline or manufacture a Coding run for this cleanup. If the task changes implementation or control state, route that separate task to CODING.

1. Confirm the user's deletion scope. Inventory is not deletion authorization. Reuse retained smoke RESIDUE records, not recursive scans of broad parent folders. The read-only parser `D:/OMPData/registry/workflow-recovery-20260908/residue-manifest.ts` converts both existing smoke log formats to an exact inventory. It does not prove present-day ownership or delete anything.
2. Freeze one manifest before execution: approved parent/target paths, originating run/log reference, marker, volume and file identity, expected fixture kind, process-quiescence checks, protected witnesses. Missing or conflicting records stay in a separate unresolved list; do not gradually relax marker requirements after a failed pass.
3. Sol executes the complete fixed manifest using its command tool and the existing trusted Windows handle-relative/no-follow cleanup mechanism. daily-worker may inventory or summarize; its text tools cannot perform deletion, so never assign it the deletion step. Before each deletion, resolve the absolute target, prove it remains inside the approved scope, validate the current marker and identity, and confirm no owner process is active. If the trusted mechanism is unavailable, preserve the targets and report that concrete capability gap. A name prefix, lack of Git remote or elapsed TTL is not ownership proof. Never follow junctions.
4. Record per-target outcomes durably as work proceeds. On interruption, reconcile this record with the real targets and active processes; do not restart the whole cleanup based on a skipped tool response. Never claim "nothing ran" without evidence.
5. Perform one postcheck of the same manifest plus protected witnesses. Return deleted/kept/unresolved counts and the evidence reference. Only investigate exceptions further. Independent verification, when needed, receives this final manifest and final results, not stale intermediate inventories.

No automatic TTL deletion. No scanning or deleting registry, archives, sessions, logs, credentials, production SQLite/WAL/SHM, or unknown worktrees. Do not move all fixtures under a nested worktree root: the existing project identity contract permits only direct worktree leaves. Future smoke lifecycle changes must preserve that boundary.
