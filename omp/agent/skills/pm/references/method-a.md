# PM A method route

Use this route for a new one-sentence complete-product brief. It selects the existing PM method; it does not create a phase, approval, role, budget, provider, or parallel research team. Keep the original user request, Sol constraints and decisions, PM inferences, and external evidence distinct. Public material can inform hypotheses but is never represented as a target-user interview.

Read the listed Dean Peters skills from the stable global root:

`~/.omp/agent/git/github.com/deanpeters/Product-Manager-Skills/skills/<skill-name>/SKILL.md`

Apply them as one connected, bounded assignment:

1. `discovery-process`: frame the problem, assumptions and decision-relevant unknowns; reuse applicable supplied evidence and avoid ritual interviews.
2. `jobs-to-be-done`: state the user outcome, context, current workaround, pains and expected gains.
3. `voice-of-customer-miner`: conduct only the bounded public research needed to test important friction; retain source, sample limits and what decision it affects.
4. `opportunity-solution-tree`: connect evidence-backed opportunities to plausible alternatives; recommend the option with user value, cost/tradeoff and an observable effect. Do not invent a fixed number of ideas or convert ordinary reliability into innovation.
5. `user-story`: turn accepted opportunities into stable requirement IDs, end-to-end stories and observable acceptance. Cover normal flow, first use, waiting/nonresponse, failure, cancellation and recovery, including retained records and other participants where applicable.

PM writes the single product handoff, not a JSON-only summary: `docs/product/research.md` records research, provenance and unresolved questions; `docs/product/PRD.md` records the complete product definition and links its stable requirement IDs to evidence. The PRD is reviewable only when it explicitly says `Review status: complete and reviewable` and includes complete journeys, business rules, data/state transitions, innovation choices and observable acceptance. Sol records adjudication and review/revision links in `docs/product/decisions.md`; an engineering contract references PRD IDs and version without becoming a second product authority.

Stop at an evidence-backed product recommendation or the existing budget. If access is unavailable or a consequential evidence question remains unresolved, preserve the gap and return `WEB_RESEARCH_REQUIRED` with its affected decision. Do not fabricate evidence, silently fill missing files or retry a failed path indefinitely.
