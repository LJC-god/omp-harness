---
name: fixed-route
description: Select a maintained architecture profile for a new product, reuse its verified recipe, and preserve existing project stacks. Use for new projects or explicitly requested architecture selection, not routine maintenance.
disable-model-invocation: false
---

# Maintained architecture routes

For a new product, Sol selects from `~/.omp/agent/notes/architecture-catalog.md` using the actual product requirements. Record the selected profile, decisive requirements, domain boundaries, required adaptations and verification status in the existing plan. This is a short decision, not another mandatory research or architecture-agent phase. User-selected technology takes precedence; existing projects retain their working stack and lockfile unless an authorized change requires otherwise.

Read only the selected profile's recipe. Reuse its pinned versions and working commands when the local prerequisites and relevant behavior match the recorded evidence. A profile description is not a tested scaffold. Check the template's current verification status before calling it ready. Probe only unverified or changed boundaries, such as a changed driver, runtime, authentication requirement or deployment target; do not repeat stack comparisons for every author.

Sol decides domain layering from business invariants, state transitions and integration needs, including different depth in different modules. Domain layering, events, queues and service separation are independent decisions. Neither a simple-page count nor an impressive architecture label determines correctness. The catalog does not ban a necessary domain model or mandate one for ordinary record management.

Workers keep the selected route. A consequential incompatibility returns to Sol with evidence and the smallest viable change. Sol may choose another catalog route or justify a bounded departure under existing project authorization; do not ask again merely because an old Primary/Fallback table preferred another framework. Ask only when a real user requirement or authorization is unresolved. Preserve data, contracts and required verification.

Common conventions: TypeScript for the Web routes; a supported Node LTS; pinned package-manager and dependency versions; one owner for lockfiles, shared contracts and migrations; no speculative cache/queue/state-store packages; one coherent component approach and one test framework per purpose. Prefer released compatible dependencies, not a mandatory ORM major or unverified latest tag. Keep Windows launch, stop and descendant-process behavior part of local acceptance.

Docker or another container engine requires the user's express request. No catalog entry implies container deployment, cloud accounts or paid infrastructure. Record the actual authorized destination and choose a matching native or explicitly requested deployment recipe.

The four Web profiles do not force Web technology onto native products. For a requested desktop, mobile, mini-program or data service, preserve an existing working route. Established candidates remain Tauri + React for desktop, React Native + Expo for mobile, native TypeScript/WXML/WXSS for WeChat, and Python for a genuine data/AI service. These are route candidates, not verified scaffolds; verify only the necessary platform boundary and do not create unrelated packages. A concrete native/platform requirement can justify another route through Sol's recorded decision.

Implementation, parallel ownership, independent review and Terra repair follow the global orchestration rules. This skill adds no controller, separate approval loop, compulsory architecture agent or extra acceptance gate.
