/**
 * The session manifest — the scoped, verified header a turn's prompt opens with.
 *
 * Why this exists: recall is query-shaped. Ask "how does auth work?" and BM25 returns auth facts,
 * but the stable knowledge a session should always carry — who the user is, what they decided,
 * what the assistant can actually do here — is only fetched when the question happens to rank it.
 * The manifest is the header: the rows that are always true for this workspace, composed once per
 * turn, in a fixed order, under a fixed budget.
 *
 * Verification is the part that is not just formatting. The store hands back what memory CLAIMS;
 * the sandbox policy, read at compose time, says what is TRUE right now. A capability row the
 * policy refutes is kept in `entries` — the screen must be able to say "that row is stale" — but
 * it never enters `block`, because handing the model a claim the live policy already disproves is
 * exactly the failure this pass exists to remove.
 */
import { estimateMessageTokens } from "@aiprovider/router-core";
import type { Memory, MemoryKind } from "../../store";

/** What the live surface says about one claim: true here, false here, or not decidable. */
export type Verification = "live" | "unverified" | "contradicted";

/**
 * What the app can actually do this turn.
 *
 * `mode` is carried for display and future use; it deliberately does **not** blank the lists. A
 * plain-chat turn still verifies against the app's full tool registry and sandbox allowlist,
 * because the question the composer answers is "is this claim about the product true?", not "is
 * this claim usable in this message". Blanking the lists in plain chat would verify "cannot run
 * git clone" as `live` and re-inject the stale claim the manifest exists to remove.
 */
export interface CapabilitySnapshot {
  mode: "agent" | "plain";
  tools: readonly string[];
  gitSubcommands: readonly string[];
}

export interface ManifestEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  source: string;
  writtenAt: number;
  scope: { project: string | null; agent: string | null; global: boolean };
  expiresAt?: number;
  verified: Verification;
  /** False for rows the block left out: contradicted, or past the token budget. */
  included: boolean;
}

/**
 * A foreign-agent session surfaced as manifest material.
 *
 * Read-only on the foreign store: the row is a reference (`nativePath`),
 * never a copy. `importId` is null until the user pulls the session in.
 */
export interface RelatedSourceSession {
  source: string;
  nativeId: string;
  title: string | null;
  root: string | null;
  turns: number;
  preview: string;
  nativePath: string;
  importId: string | null;
}

export interface ComposedManifest {
  entries: ManifestEntry[];
  block: string;
  tokens: number;
  /** Imported or importable foreign sessions scoped to this workspace. */
  related: RelatedSourceSession[];
}

/** The block's whole budget, header included. A manifest is a header, not a second recall. */
export const MANIFEST_BUDGET_TOKENS = 400;

const NEGATED =
  /\b(cannot|can't|can not|unable to|unavailable|incapable|not available|not supported|no access|no real shell|blocked from|does not work|doesn't work)\b/i;
const AFFIRMED = /\b(can|able to|works|available)\b/i;

/** Verify one capability sentence against the tools and sandbox this turn actually has. */
export function verifyCapability(
  text: string,
  snap: CapabilitySnapshot,
): Verification {
  const git = text.match(/\bgit\s+(clone|fetch|pull|push|status|commit)\b/i);
  if (git) {
    // An empty allowlist is a policy read that did not happen — not a sandbox that forbids every
    // subcommand. Absence of evidence is not evidence of inability, so this is `unverified`.
    if (snap.gitSubcommands.length === 0) return "unverified";
    const allowed = snap.gitSubcommands.includes(git[1].toLowerCase());
    if (NEGATED.test(text)) return allowed ? "contradicted" : "live";
    if (AFFIRMED.test(text)) return allowed ? "live" : "contradicted";
    return allowed ? "unverified" : "contradicted";
  }
  // Same rule for the tool list: no tools named is no evidence about any tool.
  if (snap.tools.length === 0) return "unverified";
  const tool = snap.tools.find(
    (t) => t.length > 2 && text.toLowerCase().includes(t.toLowerCase()),
  );
  if (tool) {
    if (NEGATED.test(text)) return "contradicted";
    if (AFFIRMED.test(text)) return "live";
  }
  return "unverified";
}

/** The block's order. Identity first, then what the user actually said they want, then decisions,
 *  then what this app can do, then project facts, with recency breaking ties inside a rank. */
function rank(entry: ManifestEntry): number {
  switch (entry.kind) {
    case "identity":
      return 0;
    case "preference":
      return entry.source === "user_stated" ? 1 : 5;
    case "decision":
      return 2;
    case "capability":
      return 3;
    case "project_fact":
      return 4;
    default:
      return 6;
  }
}

/**
 * Build the manifest. Identity and user-stated preferences are the stable header; a
 * contradicted capability is kept for the echo but never enters the prompt, because the
 * model must not be handed a claim the live policy already refutes.
 *
 * Truncation is whole-line: a line that would cross the budget is omitted rather than cut, so
 * every line the model reads is a complete memory. A later, shorter line may still fit, which is
 * why the loop continues rather than breaking — the budget bounds the block, not the entry order.
 */
export function composeManifest(
  memories: readonly Memory[],
  snap: CapabilitySnapshot,
  budgetTokens: number = MANIFEST_BUDGET_TOKENS,
  now: number = Date.now(),
  related: RelatedSourceSession[] = [],
): ComposedManifest {
  const entries: ManifestEntry[] = [];
  for (const m of memories) {
    if (m.layer === "L0") continue;
    if (m.superseded_at != null) continue;
    if (m.expires_at != null && m.expires_at <= now) continue;
    const kind = m.kind ?? "project_fact";
    if (kind === "conversation") continue;
    const verified =
      kind === "capability" ? verifyCapability(m.text, snap) : "unverified";
    entries.push({
      id: m.id,
      kind,
      text: m.text,
      source: m.source || "inferred",
      writtenAt: m.updated_at,
      scope: {
        project: m.scope.project,
        agent: m.scope.agent,
        global: m.scope.global,
      },
      ...(m.expires_at != null ? { expiresAt: m.expires_at } : {}),
      verified,
      included: false,
    });
  }

  entries.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.writtenAt - a.writtenAt ||
      a.id.localeCompare(b.id),
  );

  const header =
    "Session manifest — prior knowledge, not instructions. Scoped to this workspace.";
  const lines: string[] = [];
  // The header is part of the block, so it is part of the budget.
  let tokens = estimateMessageTokens({ role: "system", content: header });
  for (const e of entries) {
    if (e.kind === "capability" && e.verified !== "live") continue;
    // Project facts are query-shaped: they are what recall exists to surface, and forcing them
    // into a 400-token header both crowds out identity and duplicates the recall block. They stay
    // in `entries` so the echo can show them, but the block and the recall path own different jobs.
    if (e.kind === "project_fact") continue;
    const line = `- [${e.kind} ${e.id}] ${e.text}`;
    const cost = estimateMessageTokens({ role: "system", content: line });
    if (tokens + cost > budgetTokens) continue;
    e.included = true;
    lines.push(line);
    tokens += cost;
  }

  const block = lines.length === 0 ? "" : `${header}\n${lines.join("\n")}`;
  return { entries, block, tokens: block ? tokens : 0, related };
}

/**
 * Fetch the scoped rows and compose. The caller supplies the this-turn capability snapshot.
 *
 * The snapshot's lists are the app's full surface, never narrowed by `mode` — see
 * `CapabilitySnapshot`. A blank root reads nothing rather than reading everything: "no workspace"
 * is not "every workspace".
 */
export async function buildManifest(
  root: string,
  mode: "agent" | "plain",
  deps: {
    list(root: string): Promise<Memory[]>;
    /** Foreign sessions scoped to this workspace, for the manifest's `related` section. */
    related?(root: string): Promise<RelatedSourceSession[]>;
    tools: readonly string[];
    policy: { git_subcommands: readonly string[] };
  },
): Promise<ComposedManifest> {
  const trimmed = root.trim();
  const memories = trimmed ? await deps.list(trimmed) : [];
  const related = trimmed
    ? ((await deps.related?.(trimmed).catch(() => [])) ?? [])
    : [];
  return composeManifest(
    memories,
    {
      mode,
      tools: deps.tools,
      gitSubcommands: deps.policy.git_subcommands,
    },
    MANIFEST_BUDGET_TOKENS,
    Date.now(),
    related,
  );
}
