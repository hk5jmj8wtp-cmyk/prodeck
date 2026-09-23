import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { askText } from "../lib/dialogs";
import type { LiveView, NodeKind, RoutingMap, Transport } from "../lib/routing";
import { canConnect, COLUMNS, layoutGraph, newNodePos, NODE_H, NODE_W, paintGraph, type GNode, type GraphFilter, type NodePaint } from "../lib/routingLayout";

// The map as boxes and lines — the Routing Bible's diagrams, live. Loaded
// lazily by the Routing page so phones and the web viewer never fetch React
// Flow. Everything it shows comes from routingLayout.ts; everything it
// changes goes back through the page's draft (`mutate`) and is saved with
// the rest of the map.
//
// Editing gestures, and only these: drag a node to nudge it (remembered),
// drag from a right-hand port to a left-hand port to connect (kinds decide
// what may connect; a link into a door or channel asks for the socket),
// select + Delete to remove, and Add for a fresh node in its column.

export interface GraphActions {
  onMove: (nodeId: string, pos: { x: number; y: number }) => void;
  onConnect: (from: string, to: string, at?: string) => void;
  onDeleteEdges: (ids: string[]) => void;
  onDeleteNodes: (ids: string[]) => void;
  onAddNode: (kind: NodeKind, label: string, pos: { x: number; y: number }) => void;
  /** Double-click: walk this node. */
  onWalk: (nodeId: string) => void;
}

export interface RoutingGraphProps extends GraphActions {
  map: RoutingMap;
  live: LiveView;
  editing: boolean;
  filter: GraphFilter;
  onFilter: (f: GraphFilter) => void;
}

const FILTERS: { id: GraphFilter; label: string }[] = [
  { id: "slink", label: "Only SLink" },
  { id: "dante", label: "Only Dante" },
  { id: "local", label: "Only Local" },
  { id: "all", label: "Show all" },
];

const KIND_LABEL: Record<NodeKind, string> = {
  source: "Source",
  door: "Door",
  channel: "Channel",
  bus: "Bus",
  output: "Output",
  destination: "Destination",
};

type NData = { g: GNode; paint: NodePaint["paint"]; sub?: string; key: string };

const KindNode = memo(function KindNode({ data, selected }: NodeProps<Node<NData>>) {
  const { g } = data;
  const p = data.paint;
  const cls = [
    "rg-node",
    `k-${g.kind}`,
    p.dead ? "dead" : "",
    p.unverified ? "unverified" : "",
    p.muted ? "muted" : "",
    p.signal ? "signal" : "",
    g.pinned ? "pinned" : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={{ width: NODE_W, minHeight: NODE_H }} title={g.pinned ? "Nudged by hand — drag to move, or it stays here" : undefined}>
      {g.kind !== "source" && <Handle type="target" position={Position.Left} className="rg-port" />}
      <div className="rg-node-label">{g.label}</div>
      {data.sub && <div className="rg-node-sub mono">{data.sub}</div>}
      {p.signal && <span className="rg-dot" title="Signal reaching the booth" />}
      {g.kind !== "destination" && <Handle type="source" position={Position.Right} className="rg-port" />}
    </div>
  );
});

type EData = { label?: string; transport?: Transport; dead?: boolean; unverified?: boolean; live?: boolean; labelAt?: "source" | "target" };

function SocketEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<Edge<EData>>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  // Label just off the non-hub end, on the first straight run of the path.
  const lx = data?.labelAt === "source" ? sourceX + 26 : targetX - 26;
  const ly = data?.labelAt === "source" ? sourceY : targetY;
  const cls = ["rg-edge", data?.transport ? `t-${data.transport}` : "", data?.dead ? "dead" : "", data?.unverified ? "unverified" : "", data?.live ? "live" : "", selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} className={cls} markerEnd={markerEnd} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div className={`rg-edge-label mono ${data.transport ? `t-${data.transport}` : ""}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { kind: KindNode };
const edgeTypes = { socket: SocketEdge };

function Inner(props: RoutingGraphProps) {
  const { map, live, editing, filter, onFilter } = props;
  const rf = useReactFlow();
  // Geometry changes with the map or the filter. Live state changes every
  // second. They are kept apart so a tick can never rebuild the graph — that
  // was the flicker: every repaint re-seeded all nodes and edges.
  const graph = useMemo(() => layoutGraph(map, filter), [map, filter]);
  const paints = useMemo(() => paintGraph(map, graph, live), [map, graph, live]);
  const paintsRef = useRef(paints);
  paintsRef.current = paints;

  // React Flow measures nodes and handles itself and reports them back as
  // changes; in a fully controlled flow those measurements are lost and no
  // edge ever draws. So the flow owns its node/edge arrays; we seed them when
  // the layout changes and patch only the changed ones when paint changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EData>>([]);
  useEffect(() => {
    const p = paintsRef.current;
    setNodes((prev) => {
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return graph.nodes.map((g) => {
        const np = p.nodes.get(g.id);
        return {
          id: g.id,
          type: "kind",
          position: { x: g.x, y: g.y },
          data: { g, paint: np?.paint ?? { unverified: true }, sub: np?.sub, key: np?.key ?? "" },
          draggable: editing,
          connectable: editing,
          selected: sel.has(g.id),
        };
      });
    });
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "socket",
        data: { label: e.label, transport: e.transport, dead: e.dead, unverified: e.unverified, live: p.liveEdges.has(e.id), labelAt: e.labelAt },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        selectable: editing,
        deletable: editing,
        animated: p.liveEdges.has(e.id),
      })),
    );
  }, [graph, editing, setNodes, setEdges]);

  // Paint tick: touch only nodes whose key changed and edges whose live flag
  // flipped. Untouched objects keep their identity, so React Flow's memoised
  // node components don't re-render at all.
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const np = paints.nodes.get(n.id);
        if (!np || np.key === n.data.key) return n;
        changed = true;
        return { ...n, data: { ...n.data, paint: np.paint, sub: np.sub, key: np.key } };
      });
      return changed ? next : prev;
    });
    setEdges((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        const live = paints.liveEdges.has(e.id);
        if (!!e.data?.live === live) return e;
        changed = true;
        return { ...e, data: { ...e.data, live }, animated: live };
      });
      return changed ? next : prev;
    });
  }, [paints, setNodes, setEdges]);

  // Fit to WIDTH, once per filter change (and on first paint). A sixty-four
  // channel column is taller than any screen; fitting everything made the
  // text unreadable. Fit the six columns across, anchor at the top, and let
  // the wheel scroll down the sheet — a nudge or a mute never moves the view.
  const ready = useNodesInitialized();
  const canvasW = useStore((s) => s.width);
  const fitKey = `${filter}:${graph.nodes.length}`;
  const [fitted, setFitted] = useState("");
  const fitWidth = useCallback(() => {
    if (!canvasW) return;
    const zoom = Math.min(1.15, Math.max(0.45, (canvasW - 24) / graph.width));
    const x = Math.max(0, (canvasW - graph.width * zoom) / 2);
    rf.setViewport({ x, y: 8, zoom }, { duration: 200 });
  }, [canvasW, graph.width, rf]);
  useEffect(() => {
    if (!ready || fitted === fitKey) return;
    setFitted(fitKey);
    fitWidth();
  }, [ready, fitKey, fitted, fitWidth]);

  const kindOf = useCallback((id: string) => map.nodes.find((n) => n.id === id)?.kind, [map]);

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!editing || !c.source || !c.target) return;
      const a = kindOf(c.source);
      const b = kindOf(c.target);
      if (!a || !b || !canConnect(a, b)) return;
      let at: string | undefined;
      if (b === "door" || b === "channel") {
        const toLabel = map.nodes.find((n) => n.id === c.target)?.label ?? b;
        const v = await askText(b === "door" ? `Which socket on ${toLabel} does this land on?` : `Which ${toLabel} socket feeds this channel? (the door's input number)`, "");
        if (v === null) return;
        at = v.trim() || undefined;
      }
      props.onConnect(c.source, c.target, at);
    },
    [editing, kindOf, map, props],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const a = kindOf(c.source);
      const b = kindOf(c.target);
      return !!a && !!b && canConnect(a, b);
    },
    [kindOf],
  );

  async function addNode(kind: NodeKind) {
    const label = await askText(kind === "channel" ? "Channel number (or a stereo range like 11-12)" : `Name for the new ${KIND_LABEL[kind].toLowerCase()}`, "");
    if (!label || !label.trim()) return;
    props.onAddNode(kind, label.trim(), newNodePos(graph, kind));
  }
  // newNodePos is only a hint for where to scroll; the node itself is left
  // unpinned so the layout puts it in its column whatever filter is on.

  const theme = typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";

  return (
    <>
      <div className="rg-toolbar">
        <div className="rg-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? "on" : ""} onClick={() => onFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        {editing && (
          <div className="rg-add">
            <span className="rg-add-label mono">Add</span>
            {COLUMNS.map((k) => (
              <button key={k} onClick={() => addNode(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <button className="rg-fit" onClick={fitWidth} title="Fit the columns to the window">
          Fit
        </button>
        <span className="rg-hint">{editing ? "Drag to nudge · port to port connects · Delete removes · double-click walks · scroll to move, ⌘-scroll to zoom" : "Scroll to move down the sheet · ⌘-scroll or pinch to zoom · double-click a box to walk it"}</span>
      </div>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      minZoom={0.25}
      maxZoom={2}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomActivationKeyCode={["Meta", "Control"]}
      nodesDraggable={editing}
      nodesConnectable={editing}
      elementsSelectable
      onNodeDragStop={(_, n) => editing && props.onMove(n.id, n.position)}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodesDelete={(ns) => editing && props.onDeleteNodes(ns.map((n) => n.id))}
      onEdgesDelete={(es) => editing && props.onDeleteEdges(es.map((e) => e.id))}
      onNodeDoubleClick={(_, n) => props.onWalk(n.id)}
      deleteKeyCode={editing ? ["Backspace", "Delete"] : null}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
      <Panel position="bottom-left" className="rg-legend mono">
        <span className="rg-leg t-slink">SLink</span>
        <span className="rg-leg t-dante">Dante</span>
        <span className="rg-leg t-local">Local</span>
        <span className="rg-leg dashed">dead</span>
        <span className="rg-leg dotted">unverified</span>
        <span className="rg-leg live">signal</span>
      </Panel>
    </ReactFlow>
    </>
  );
}

export default function RoutingGraph(props: RoutingGraphProps) {
  return (
    <div className="rg-wrap">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
