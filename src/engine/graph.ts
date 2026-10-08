// The typed relationship graph — which concepts and edges to show,
// and a deterministic force-directed layout (same input, same picture).

import type { BundleIndex } from "./bundle";

export interface GraphNode {
  /** Bundle path. */
  id: string;
  label: string;
  /** semantic / episodic / procedural. */
  conceptType?: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Relationship types present, sorted: the legend, and stable colour slots. */
  types: string[];
}

/**
 * Concepts and resolved edges of a bundle. With `center`, only concepts
 * within `depth` hops of it (either direction).
 */
export function graphOf(index: BundleIndex, opts: { center?: string; depth?: number; types?: Set<string> } = {}): Graph {
  const edges: GraphEdge[] = [];
  for (const list of index.outgoing.values()) {
    for (const e of list) {
      if (e.resolved && index.concepts.has(e.resolved) && (!opts.types || opts.types.has(e.type))) edges.push({ from: e.from, to: e.resolved, type: e.type });
    }
  }
  let keep: Set<string>;
  if (opts.center && index.concepts.has(opts.center)) {
    keep = new Set([opts.center]);
    let frontier = [opts.center];
    for (let d = 0; d < (opts.depth ?? 1); d++) {
      const next: string[] = [];
      for (const e of edges) {
        for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
          if (frontier.includes(a) && !keep.has(b)) {
            keep.add(b);
            next.push(b);
          }
        }
      }
      frontier = next;
    }
  } else {
    keep = new Set(index.concepts.keys());
  }
  const nodes = [...keep].sort().map((id) => {
    const c = index.concepts.get(id)!;
    const title = typeof c.frontmatter.title === "string" ? c.frontmatter.title : id.split("/").pop()!.replace(/\.md$/, "");
    return { id, label: title, conceptType: typeof c.frontmatter.type === "string" ? c.frontmatter.type : undefined, x: 0, y: 0 };
  });
  const shown = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes, edges: shown, types: [...new Set(shown.map((e) => e.type))].sort() };
}

/** Mulberry32: a small seeded PRNG, so layouts are reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fruchterman–Reingold layout in a `size` × `size` square centred on 0,
 * in place. Deterministic for a given graph and seed.
 */
export function layout(graph: Graph, opts: { size?: number; iterations?: number; seed?: number } = {}): Graph {
  const size = opts.size ?? 1000;
  const n = graph.nodes.length;
  if (n === 0) return graph;
  const rand = prng(opts.seed ?? 7);
  const k = Math.sqrt((size * size) / n) * 0.6;
  for (const node of graph.nodes) {
    node.x = (rand() - 0.5) * size;
    node.y = (rand() - 0.5) * size;
  }
  if (n === 1) {
    graph.nodes[0]!.x = 0;
    graph.nodes[0]!.y = 0;
    return graph;
  }
  const at = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const iterations = opts.iterations ?? 300;
  let temperature = size / 10;
  for (let it = 0; it < iterations; it++) {
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = graph.nodes[i]!;
        const b = graph.nodes[j]!;
        let x = a.x - b.x;
        let y = a.y - b.y;
        let d = Math.hypot(x, y);
        if (d < 0.01) {
          x = rand() - 0.5;
          y = rand() - 0.5;
          d = 0.01;
        }
        const f = (k * k) / d;
        dx[i]! += (x / d) * f;
        dy[i]! += (y / d) * f;
        dx[j]! -= (x / d) * f;
        dy[j]! -= (y / d) * f;
      }
    }
    for (const e of graph.edges) {
      const i = at.get(e.from)!;
      const j = at.get(e.to)!;
      if (i === j) continue;
      const a = graph.nodes[i]!;
      const b = graph.nodes[j]!;
      const x = a.x - b.x;
      const y = a.y - b.y;
      const d = Math.max(Math.hypot(x, y), 0.01);
      const f = (d * d) / k;
      dx[i]! -= (x / d) * f;
      dy[i]! -= (y / d) * f;
      dx[j]! += (x / d) * f;
      dy[j]! += (y / d) * f;
    }
    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i]!;
      // Gentle pull to the centre keeps disconnected parts on screen.
      dx[i]! -= node.x * 0.01 * k;
      dy[i]! -= node.y * 0.01 * k;
      const d = Math.max(Math.hypot(dx[i]!, dy[i]!), 0.01);
      const step = Math.min(d, temperature);
      node.x = Math.max(-size / 2, Math.min(size / 2, node.x + (dx[i]! / d) * step));
      node.y = Math.max(-size / 2, Math.min(size / 2, node.y + (dy[i]! / d) * step));
    }
    temperature = Math.max(temperature * 0.97, 0.5);
  }
  return graph;
}
