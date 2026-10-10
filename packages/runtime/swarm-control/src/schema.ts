/** Shared policy strings. Hosts may add their own flag or env names in documentation. */

export const SWARM_OFF_REASON = "Agent swarm is off. Pass --swarm, run /swarm, or set OMP_SWARM=1.";

export const ORCH_BUDGET_REASON = "Swarm step budget exhausted: synthesize the final answer now.";

export const STAGE_CAP_REASON = "Sub-agent cap reached for this stage; merge or reuse results.";

export const TOTAL_CAP_REASON = "Sub-agent cap reached for this run; merge or reuse results.";

export const WRITE_ISOLATION_REASON =
	"Write-capable swarm workers require an isolated worktree. Read-only workers use the scout agent.";

export const SINGLE_WRITER_REASON =
	"A swarm stage allows one isolated writer. Read-only workers may run beside that writer; other writers must wait.";

export const UNKNOWN_AGENT_REASON = "Unknown subagent. Call create_subagent first.";

export const STEPS_DEFINITION = "assistant_llm_turns";

export const SWARM_TOOL_NAMES = ["create_subagent", "assign_task", "swarm_status"] as const;

export type SwarmToolName = (typeof SWARM_TOOL_NAMES)[number];

/** Pi workers. OMP native agents use a different read-only set and do not import this list. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** OMP bundled agents whose native tool lists do not include bash, edit, or write. */
export const READ_ONLY_AGENTS = ["scout", "security-reviewer"] as const;

export const WRITE_TOOLS = ["bash", "edit", "write", "eval"] as const;

export const CREATE_SUBAGENT_DESCRIPTION =
	"Create a custom subagent with specific system prompt and name for reuse.";

export const ASSIGN_TASK_DESCRIPTION =
	"Launch a new agent.\nUsage notes:\n 1. You can launch multiple agents concurrently whenever possible, to maximize performance;\n 2. When the agent is done, it will return a single message back to you.";

export const ORCHESTRATOR_RULES = `Decompose only when it shortens the critical path. Critical steps = sum over stages of (1 + the slowest sub-agent). A step is one assistant LLM turn, not one tool call.

Call create_subagent and wait for it. In a later message, issue every independent assign_task together. Do not mix create_subagent and assign_task in one message.

Balance sub-task size. Never spawn filler tasks. After each stage, assign only coverage gaps. Re-plan failed tasks. With 2 or fewer orchestrator steps left, stop dispatching and synthesize. Call swarm_status for live counters; the budget line in this prompt is from the start of the user message.`;

export const OMP_ORCHESTRATOR_RULES = `Decompose only when it shortens the critical path. Critical steps = sum over stages of (1 + the slowest sub-agent). A step is one assistant LLM turn, not one tool call.

Swarm is on. Dispatch read-only work with the native task tool. Put independent work in one call as {"context","tasks":[{"agent":"scout","task":"..."}]}. The default agent is scout. security-reviewer is also read-only. Do not pass a tools allowlist.

A stage allows at most one writer, and only with isolated set true. Any agent other than scout or security-reviewer is a writer. Do not run two writers together.

With 2 or fewer orchestrator steps left, stop dispatching and synthesize. Call swarm_status for live counters.`;

export const WORKER_RULES = `You are a sub-agent with an isolated context. You cannot create or assign sub-agents. Use only read, grep, find, and ls. Finish with ONE JSON message and nothing else: {"status":"success"|"failure","answer":"...","evidence":["path:line"]}. Do not ask questions.`;
