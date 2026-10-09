/**
 * Subagents — the ZCode-style management screen for `dispatch_agent` specialists.
 *
 * What it deliberately does **not** show anymore: the delegated-runs history. The runs ledger
 * already has two homes — the live drawer in the Assistant (delegated runs, while they work)
 * and the Agents screen (the full run ledger with steps) — and a third table here was a
 * duplicate that nobody needed (measured 2026-10-09: the screen read as run history first and
 * as the place to manage agent types second, which is backwards). What remains is the agent
 * types card: what the agent can delegate to, add, disable, and search.
 */
import { AgentTypesCard } from "../components/AgentTypesCard";

export function SubagentsScreen() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Subagents</h1>
      </div>
      <AgentTypesCard />
    </div>
  );
}
