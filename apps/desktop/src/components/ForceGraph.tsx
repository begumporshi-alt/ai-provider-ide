/**
 * Force-directed graph on canvas.
 *
 * Written by hand rather than pulled in as a dependency: the layout needs to know our node
 * weights, our colour tokens and our selection model, and a general-purpose graph library
 * would have to be configured around all three anyway. ~200 lines of simulation is cheaper
 * than that integration, and it stays debuggable.
 *
 * Colour comes from the app's CSS custom properties, read at draw time, so the canvas follows
 * the theme instead of hard-coding a palette that would go stale.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Graph, GraphNode } from "../lib/context/engine";

const REPULSION = 1400;
const LINK_DISTANCE = 78;
const LINK_STIFFNESS = 0.035;
const CENTER_PULL = 0.012;
const DAMPING = 0.86;
const MAX_SPEED = 12;

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  node: GraphNode;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Colour per node kind. Anything unlisted falls back to the muted token, never to nothing. */
function kindColor(kind: string, palette: Record<string, string>): string {
  return palette[kind] ?? palette._muted ?? "#888";
}

export function ForceGraph({
  graph,
  height = 460,
  selectedId,
  onSelect,
}: {
  graph: Graph;
  height?: number;
  selectedId?: string | null;
  onSelect?: (n: GraphNode | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bodies = useRef<Map<string, Body>>(new Map());
  const view = useRef({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id: string | null; px: number; py: number; panning: boolean } | null>(null);
  const alpha = useRef(1);
  const [hover, setHover] = useState<GraphNode | null>(null);

  const palette = useMemo(
    () => ({
      message: cssVar("--text", "#111"),
      artifact: cssVar("--ai", "#7c5cff"),
      skill: cssVar("--success", "#1a7f37"),
      memory: cssVar("--warn", "#b45309"),
      provider: cssVar("--info", "#185fa5"),
      key: cssVar("--text-dim", "#666"),
      model: cssVar("--success", "#1a7f37"),
      alias: cssVar("--ai", "#7c5cff"),
      requested: cssVar("--warn", "#b45309"),
      "request-ok": cssVar("--success", "#1a7f37"),
      "request-failed": cssVar("--danger", "#b42318"),
      _muted: cssVar("--text-faint", "#999"),
    }),
    [],
  );

  // Seed new nodes near the centre with a little jitter; keep existing positions so the graph
  // does not teleport every time data refreshes.
  useEffect(() => {
    const cw = wrapRef.current?.clientWidth ?? 800;
    const cx = cw / 2;
    const cy = height / 2;
    const next = new Map<string, Body>();
    for (const n of graph.nodes) {
      const existing = bodies.current.get(n.id);
      if (existing) {
        existing.node = n;
        next.set(n.id, existing);
      } else {
        next.set(n.id, {
          id: n.id,
          x: cx + (Math.random() - 0.5) * 120,
          y: cy + (Math.random() - 0.5) * 120,
          vx: 0,
          vy: 0,
          node: n,
        });
      }
    }
    bodies.current = next;
    alpha.current = 1;
  }, [graph, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const w = wrapRef.current?.clientWidth ?? 800;
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    window.addEventListener("resize", resize);

    const step = () => {
      const list = Array.from(bodies.current.values());
      const cx = (wrapRef.current?.clientWidth ?? 800) / 2;
      const cy = height / 2;
      const a = alpha.current;

      if (a > 0.005) {
        for (const b of list) {
          b.vx *= DAMPING;
          b.vy *= DAMPING;
        }
        // Repulsion: every pair pushes apart, which is what makes disconnected clusters
        // separate instead of collapsing into one blob.
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const p = list[i];
            const q = list[j];
            let dx = q.x - p.x;
            let dy = q.y - p.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) {
              dx = (Math.random() - 0.5) * 2;
              dy = (Math.random() - 0.5) * 2;
              d2 = 4;
            }
            const f = (REPULSION / d2) * a;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            p.vx -= fx;
            p.vy -= fy;
            q.vx += fx;
            q.vy += fy;
          }
        }
        for (const e of graph.edges) {
          const p = bodies.current.get(e.from);
          const q = bodies.current.get(e.to);
          if (!p || !q) continue;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
          const f = (d - LINK_DISTANCE) * LINK_STIFFNESS * a;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          p.vx += fx;
          p.vy += fy;
          q.vx -= fx;
          q.vy -= fy;
        }
        for (const b of list) {
          b.vx += (cx - b.x) * CENTER_PULL * a;
          b.vy += (cy - b.y) * CENTER_PULL * a;
          const speed = Math.hypot(b.vx, b.vy);
          if (speed > MAX_SPEED) {
            b.vx = (b.vx / speed) * MAX_SPEED;
            b.vy = (b.vy / speed) * MAX_SPEED;
          }
          b.x += b.vx;
          b.y += b.vy;
        }
        alpha.current *= 0.985;
      }

      // ---- draw ----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(view.current.x, view.current.y);
      ctx.scale(view.current.k, view.current.k);

      const edgeColor = cssVar("--border", "#ddd");
      ctx.strokeStyle = edgeColor;
      for (const e of graph.edges) {
        const p = bodies.current.get(e.from);
        const q = bodies.current.get(e.to);
        if (!p || !q) continue;
        ctx.lineWidth = Math.min(0.8 + Math.log2(1 + e.weight) * 0.5, 3);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }

      for (const b of list) {
        const r = 4 + Math.min(Math.sqrt(b.node.weight ?? 1) * 1.9, 12);
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fillStyle = kindColor(b.node.kind, palette);
        ctx.fill();
        if (b.id === selectedId || hover?.id === b.id) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = cssVar("--text", "#111");
          ctx.stroke();
        }
      }

      // Labels only for the heavier nodes — labelling everything turns a graph into a word cloud.
      ctx.fillStyle = cssVar("--text-dim", "#555");
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      for (const b of list) {
        if ((b.node.weight ?? 0) < 2) continue;
        ctx.fillText(clip(b.node.label, 22), b.x + 10, b.y + 4);
      }
      ctx.restore();

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [graph, height, palette, selectedId, hover]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.current.x) / view.current.k,
      y: (clientY - rect.top - view.current.y) / view.current.k,
    };
  };

  const pick = (clientX: number, clientY: number): GraphNode | null => {
    const w = toWorld(clientX, clientY);
    for (const b of bodies.current.values()) {
      const r = 4 + Math.min(Math.sqrt(b.node.weight ?? 1) * 1.9, 12);
      if (Math.hypot(b.x - w.x, b.y - w.y) <= r + 3) return b.node;
    }
    return null;
  };

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab rounded"
        style={{ background: "var(--surface)" }}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          const k = Math.min(Math.max(view.current.k * factor, 0.25), 4);
          const applied = k / view.current.k;
          view.current = {
            k,
            x: mx - (mx - view.current.x) * applied,
            y: my - (my - view.current.y) * applied,
          };
        }}
        onMouseDown={(e) => {
          const hit = pick(e.clientX, e.clientY);
          if (hit) {
            drag.current = { id: hit.id, px: e.clientX, py: e.clientY, panning: false };
            onSelect?.(hit);
          } else {
            drag.current = { id: null, px: e.clientX, py: e.clientY, panning: true };
            onSelect?.(null);
          }
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) {
            setHover(pick(e.clientX, e.clientY));
            return;
          }
          if (d.panning) {
            view.current = { ...view.current, x: view.current.x + (e.clientX - d.px), y: view.current.y + (e.clientY - d.py) };
            d.px = e.clientX;
            d.py = e.clientY;
          } else if (d.id) {
            const b = bodies.current.get(d.id);
            if (b) {
              const w = toWorld(e.clientX, e.clientY);
              b.x = w.x;
              b.y = w.y;
              b.vx = 0;
              b.vy = 0;
              alpha.current = Math.max(alpha.current, 0.5);
            }
          }
        }}
        onMouseUp={() => {
          drag.current = null;
        }}
        onMouseLeave={() => {
          drag.current = null;
          setHover(null);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none absolute left-2 top-2 rounded px-2 py-1 text-[11px]"
          style={{ background: "var(--surface-2)", color: "var(--text)" }}
        >
          <b>{hover.kind}</b> · {hover.label}
          {hover.detail ? <span style={{ color: "var(--text-dim)" }}> — {hover.detail}</span> : null}
        </div>
      )}
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
