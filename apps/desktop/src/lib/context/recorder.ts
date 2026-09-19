/**
 * Context recorder — turns what actually happens into graph records.
 *
 * Deliberately not a general event bus. Four things exist in this app that are worth relating:
 * a message was sent, an artifact was produced, a skill ran, a memory was recalled. Anything
 * else would be a node type invented for the sake of having one.
 *
 * Writes are buffered and flushed as one batch, because a turn is a unit: a message with no
 * edge to the artifact it produced is a graph that lies about provenance.
 */
import { recordContext } from "../../store";
import type { HostContextNode, HostContextEdge } from "./engine";
import type { ContextNodeKind, ContextEdgeKind } from "./engine";

export interface Recorder {
  readonly sessionId: string;
  node(kind: ContextNodeKind, label: string, meta?: Record<string, unknown>): string;
  edge(fromId: string, toId: string, kind: ContextEdgeKind, meta?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

class BufferedRecorder implements Recorder {
  private nodes: HostContextNode[] = [];
  private edges: HostContextEdge[] = [];
  private seq = 0;

  constructor(readonly sessionId: string) {}

  private nextId(kind: ContextNodeKind): string {
    this.seq += 1;
    return `${kind}:${this.sessionId}:${this.seq}`;
  }

  node(kind: ContextNodeKind, label: string, meta?: Record<string, unknown>): string {
    const id = this.nextId(kind);
    this.nodes.push({
      id,
      kind,
      label,
      source: "ui",
      session_id: this.sessionId,
      ts: Date.now(),
      meta_json: meta ? JSON.stringify(meta) : null,
    });
    return id;
  }

  edge(fromId: string, toId: string, kind: ContextEdgeKind, meta?: Record<string, unknown>): void {
    this.edges.push({
      id: `e:${fromId}->${toId}:${kind}`,
      from_id: fromId,
      to_id: toId,
      kind,
      weight: 1,
      ts: Date.now(),
      meta_json: meta ? JSON.stringify(meta) : null,
    });
  }

  /**
   * Fire-and-forget by design: a failed graph write must never break the thing being recorded.
   * The buffer is cleared either way — retrying would replay stale ids against a session that
   * has moved on.
   */
  async flush(): Promise<void> {
    const nodes = this.nodes;
    const edges = this.edges;
    this.nodes = [];
    this.edges = [];
    try {
      await recordContext(nodes, edges);
    } catch {
      // Intentionally swallowed: see the note above.
    }
  }
}

let current: Recorder | null = null;

/** One recorder per session; a new session resets the sequence so ids stay stable per turn. */
export function startSession(sessionId = `s-${Date.now()}`): Recorder {
  current = new BufferedRecorder(sessionId);
  return current;
}

export function activeSession(): Recorder {
  return current ?? startSession();
}
