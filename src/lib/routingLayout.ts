// The node view's brain: which nodes and edges to show for a filter, where
// each one sits, and what may connect to what. Pure and tested; the React
// Flow component only draws what this returns.
//
// Layout is by KIND, not by hand: six columns, source → door → channel → bus
// → output → destination, ordered inside each column by dagre so edges cross
// as little as possible. A manual nudge (`pos`) is honoured for that node
// only; everything else stays in its column. Free-form placement is what
// makes node editors unreadable — the Routing Bible's diagrams are readable
// because they never do it.

import dagre from "@dagrejs/dagre";
import {
  deskKeyFor,
  edgesInto,
  firstIndex,
  node,
  type LiveView,
  type NodeKind,
  type REdge,
  type RNode,
  type RoutingMap,
  type Transport,
} from "./routing";

export const COLUMNS: NodeKind[] = ["source", "door", "channel", "bus", "output", "destination"];

export const NODE_W = 168;
export const NODE_H = 40;
const COL_GAP = 90;
const ROW_GAP = 10;

export type GraphFilter = "all" | Transport;

/** Live state painted onto a node, computed once per render. */
export interface Paint {
  muted?: boolean;
  faderDb?: number;
  deskName?: string;
  /** Signal at the booth's own input bound to this node. */
  signal?: boolean;
  dead?: boolean;
  /** No verification stamp anywhere on this node. */
  unverified: boolean;
}

export interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  x: number;
  y: number;
  paint: Paint;
  /** Position came from a manual nudge, not the layout. */
  pinned: boolean;
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  transport?: Transport;
  dead?: boolean;
  unverified: boolean;
  /** Live signal is flowing here as far as ProDeck can see. */
  live?: boolean;
  /** Which end the socket label sits near: the end that is NOT the hub. A
   *  door has dozens of edges into one port; labels at its end pile up. */
  labelAt: "source" | "target";
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

/** The transports a door carries; a node's transport is its door's. */
function transportOf(map: RoutingMap, n: RNode, memo: Map<string, Set<Transport>>): Set<Transport> {
  const hit = memo.get(n.id);
  if (hit) return hit;
  const out = new Set<Transport>();
  memo.set(n.id, out); // cycle guard
  if (n.kind === "door" && n.transport) out.add(n.transport);
  else if (n.kind === "source") {
    for (const e of map.edges.filter((x) => x.from === n.id)) {
      const d = node(map, e.to);
      if (d) for (const t of transportOf(map, d, memo)) out.add(t);
    }
  } else if (n.kind === "channel") {
    for (const e of edgesInto(map, n.id)) {
      const d = node(map, e.from);
      if (d) for (const t of transportOf(map, d, memo)) out.add(t);
    }
  } else if (n.kind === "output" && n.transport) out.add(n.transport);
  else if (n.kind === "bus") {
    for (const e of map.edges.filter((x) => x.from === n.id)) {
      const o = node(map, e.to);
      if (o?.transport) out.add(o.transport);
    }
  } else if (n.kind === "destination") {
    for (const e of edgesInto(map, n.id)) {
      const o = node(map, e.from);
      if (o) for (const t of transportOf(map, o, memo)) out.add(t);
    }
  }
  return out;
}

/** Nodes and edges that belong to one door's world — the Bible's
 *  "Only SLink · Only Dante · Only Local" buttons. */
export function filterMap(map: RoutingMap, filter: GraphFilter): { nodes: RNode[]; edges: REdge[] } {
  if (filter === "all") return { nodes: map.nodes, edges: map.edges };
  const memo = new Map<string, Set<Transport>>();
  const keep = new Set(map.nodes.filter((n) => transportOf(map, n, memo).has(filter)).map((n) => n.id));
  const edges = map.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && (!e.transport || e.transport === filter));
  return { nodes: map.nodes.filter((n) => keep.has(n.id)), edges };
}

const fmtDb = (v: number) => (v === -Infinity || v <= -70 ? "−∞" : `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v))}`);

export function paintFor(n: RNode, live: LiveView): Paint {
  const p: Paint = { dead: n.dead, unverified: typeof n.verified !== "number" };
  const key = n.kind === "channel" || n.kind === "bus" ? deskKeyFor(n) : n.bind?.desk;
  if (key && live.desk?.connected) {
    p.muted = live.desk.mutes[key] === true;
    const f = live.desk.faders[key];
    if (typeof f === "number") p.faderDb = f;
    const nm = (live.desk.names[key] ?? "").trim();
    if (nm) p.deskName = nm;
  }
  if (n.bind?.capture && live.capture && live.now - live.capture.at < 5000) {
    const pk = live.capture.peaks[n.bind.capture - 1];
    if (typeof pk === "number") p.signal = pk > 0 && 20 * Math.log10(pk) > -60;
  }
  return p;
}

/** The second line on a node: the number that doesn't move, plus live state. */
export function subFor(n: RNode, paint: Paint): string | undefined {
  const bits: string[] = [];
  if (n.kind === "channel") {
    if (paint.deskName && paint.deskName !== n.label) bits.push(`“${paint.deskName}”`);
    if (paint.muted) bits.push("muted");
    else if (typeof paint.faderDb === "number") bits.push(`${fmtDb(paint.faderDb)} dB`);
  } else if (n.kind === "source" && n.ref) {
    bits.push(`${n.ref.port} ${n.ref.index}`.trim());
  } else if (n.kind === "door") {
    bits.push(n.transport ?? "");
  } else if (n.kind === "output" && n.ref) {
    bits.push(n.ref.index);
  }
  if (paint.dead) bits.push("dead");
  return bits.filter(Boolean).join(" · ") || undefined;
}

/**
 * Lay the (filtered) map out in columns. Nodes with a saved `pos` keep it;
 * dagre orders the rest within their column to reduce crossings.
 */
export function layoutGraph(map: RoutingMap, filter: GraphFilter, live: LiveView): Graph {
  const { nodes, edges } = filterMap(map, filter);
  // dagre decides the ORDER within each column (fewest crossings). Columns
  // themselves are fixed: x is a straight function of kind, so a lone source
  // with no edges still sits with the other sources, not wherever dagre's
  // ranker would have put it.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP, ranker: "longest-path" });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const colX = (k: NodeKind) => 20 + COLUMNS.indexOf(k) * (NODE_W + COL_GAP);

  const byCol = new Map<NodeKind, RNode[]>();
  for (const n of nodes) byCol.set(n.kind, [...(byCol.get(n.kind) ?? []), n]);
  const out: GNode[] = [];
  for (const [kind, list] of byCol) {
    const sorted = [...list].sort((a, b) => {
      const ya = g.node(a.id)?.y ?? 0;
      const yb = g.node(b.id)?.y ?? 0;
      if (Math.abs(ya - yb) > 0.5) return ya - yb;
      return firstIndex(a.ref?.index) - firstIndex(b.ref?.index);
    });
    let y = 20;
    for (const n of sorted) {
      const paint = paintFor(n, live);
      const pinned = !!n.pos;
      out.push({
        id: n.id,
        kind,
        label: n.label || (n.kind === "channel" ? `Channel ${n.ref?.index ?? ""}` : n.id),
        sub: subFor(n, paint),
        x: pinned ? n.pos!.x : colX(kind),
        y: pinned ? n.pos!.y : y,
        paint,
        pinned,
      });
      y += NODE_H + ROW_GAP;
    }
  }

  const gEdges: GEdge[] = edges.map((e) => {
    const to = node(map, e.to);
    const toPaint = to ? paintFor(to, live) : undefined;
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.at,
      transport: e.transport,
      dead: e.dead || node(map, e.from)?.dead || to?.dead,
      unverified: typeof e.verified !== "number",
      live: toPaint?.signal === true,
      labelAt: to?.kind === "door" || to?.kind === "bus" ? "source" : "target",
    };
  });
  return { nodes: out, edges: gEdges };
}

/** Kinds constrain what can connect to what: a source can't wire straight
 *  into a bus. Same-kind links are never allowed. */
export function canConnect(from: NodeKind, to: NodeKind): boolean {
  const a = COLUMNS.indexOf(from);
  const b = COLUMNS.indexOf(to);
  if (a < 0 || b < 0 || a === b) return false;
  // Forward one column, or a channel straight into an output (a direct
  // out) — the two shapes real desks have.
  return b === a + 1 || (from === "channel" && to === "output");
}

/** Where a brand-new node of a kind lands: its column, below the others. */
export function newNodePos(graph: Graph, kind: NodeKind): { x: number; y: number } {
  const col = graph.nodes.filter((n) => n.kind === kind);
  const x = col[0]?.x ?? 20 + COLUMNS.indexOf(kind) * (NODE_W + COL_GAP);
  const y = col.length ? Math.max(...col.map((n) => n.y)) + NODE_H + ROW_GAP : 20;
  return { x, y };
}
