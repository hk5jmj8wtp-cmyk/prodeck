import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { askText } from "../lib/dialogs";
import type { LiveView, NodeKind, RoutingMap, Transport } from "../lib/routing";
import { canConnect, COLUMNS, layoutGraph, newNodePos, NODE_H, NODE_W, type GNode, type GraphFilter } from "../lib/routingLayout";

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

type NData = { g: GNode };

const KindNode = memo(function KindNode({ data, selected }: NodeProps<Node<NData>>) {
  const { g } = data;
  const p = g.paint;
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
      {g.sub && <div className="rg-node-sub mono">{g.sub}</div>}
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
  const graph = useMemo(() => layoutGraph(map, filter, live), [map, filter, live]);

  // React Flow measures nodes and handles itself and reports them back as
  // changes; in a fully controlled flow those measurements are lost and no
  // edge ever draws. So the flow owns its node/edge arrays and we re-seed
  // them whenever the layout changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EData>>([]);
  useEffect(() => {
    setNodes((prev) => {
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return graph.nodes.map((g) => ({
        id: g.id,
        type: "kind",
        position: { x: g.x, y: g.y },
        data: { g },
        draggable: editing,
        connectable: editing,
        selected: sel.has(g.id),
      }));
    });
    setEdges(
      graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "socket",
        data: { label: e.label, transport: e.transport, dead: e.dead, unverified: e.unverified, live: e.live, labelAt: e.labelAt },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        selectable: editing,
        deletable: editing,
        animated: e.live,
      })),
    );
  }, [graph, editing, setNodes, setEdges]);

  // Fit once per filter change (and on first paint), not on every live
  // repaint — a nudge or a mute must not yank the view around. React Flow
  // measures nodes a frame after they mount; `useNodesInitialized` flips
  // when every node has a size, and only then does a fit mean anything.
  const ready = useNodesInitialized();
  const fitKey = `${filter}:${graph.nodes.length}`;
  const [fitted, setFitted] = useState("");
  useEffect(() => {
    if (!ready || fitted === fitKey) return;
    setFitted(fitKey);
    rf.fitView({ padding: 0.1, duration: 250, maxZoom: 1.1 });
  }, [ready, fitKey, fitted, rf]);

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
        <span className="rg-hint">{editing ? "Drag to nudge · drag port to port to connect · Delete removes · double-click walks" : "Double-click a box to walk it · Edit to change the map"}</span>
      </div>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      fitView
      minZoom={0.15}
      maxZoom={2}
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
