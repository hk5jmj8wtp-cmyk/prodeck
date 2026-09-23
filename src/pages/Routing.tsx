import { useEffect, useMemo, useState } from "react";
import { IS_DEMO, IS_WEB } from "../lib/tauri";
import { askConfirm } from "../lib/dialogs";
import { useRouting, useRoutingLive } from "../routingStore";
import { WalkPicker, WalkView } from "../components/RoutingWalk";
import {
  ageText,
  applyRow,
  channelRows,
  deskKeyFor,
  DOOR_LABELS,
  edgesInto,
  node,
  parsePatchList,
  removeChannel,
  STALE_AFTER_MS,
  stepsFor,
  toPatchList,
  type ChannelRow,
  type RoutingMap,
  type Transport,
} from "../lib/routing";

// Routing — the building's signal map, as the table every sound tech already
// has (CH · NAME · PORT · SOCKET · UPSTREAM) and as the walk a volunteer uses
// when a mic is dead. Spec: design/ROUTING.md. Numbers are the key; names
// arrive live from the desk and are only ever an override here.
//
// Booth edits a draft and saves it; phones read. Nothing is written until the
// file has been read successfully once — a map a church typed in is not ours
// to replace with a seed.

type Tab = "channels" | "walk";

const PORT_OPTIONS: { value: Transport | ""; label: string }[] = [
  { value: "", label: "— not patched" },
  { value: "slink", label: "SLink / stage box" },
  { value: "dante", label: "I/O Port 1 (Dante)" },
  { value: "local", label: "Local (rack XLR)" },
  { value: "me", label: "ME" },
  { value: "analog", label: "Analog" },
  { value: "other", label: "Other" },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
/** Editing is booth-only — except in demo mode, where trying the table with
 *  sample data is the point and nothing is written anywhere. */
const CAN_EDIT = !IS_WEB || IS_DEMO;

export function RoutingPage() {
  const routing = useRouting();
  const live = useRoutingLive();
  const [tab, setTab] = useState<Tab>("channels");
  const [draft, setDraft] = useState<RoutingMap | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [walkTarget, setWalkTarget] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const map = draft ?? routing.map;
  const editing = draft !== null;
  const rows = useMemo(() => (map ? channelRows(map) : []), [map]);
  const now = live.now;

  // A migrated map is shown as a draft straight away: it is theirs to keep.
  useEffect(() => {
    if (routing.migrated && routing.map && !draft && CAN_EDIT) setDraft(clone(routing.map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing.migrated, routing.map]);

  function mutate(fn: (m: RoutingMap) => void) {
    setDraft((d) => {
      const m = clone(d ?? routing.map!);
      fn(m);
      return m;
    });
  }

  async function save() {
    if (!draft) return;
    await routing.save(draft);
    setDraft(null);
    setOpen(null);
  }

  async function cancel() {
    if (routing.migrated) {
      const ok = await askConfirm("Discard the converted map? The old file stays as it was until you save.", "Discard");
      if (!ok) return;
    }
    setDraft(null);
    setOpen(null);
  }

  function verifyAll() {
    mutate((m) => {
      const at = Date.now();
      m.nodes.forEach((n) => (n.verified = at));
      m.edges.forEach((e) => (e.verified = at));
      m.verified = { at, by: "booth" };
    });
  }

  function applyPaste() {
    const p = parsePatchList(pasteText);
    if (p.rows.length === 0) return;
    mutate((m) => {
      for (const r of p.rows) applyRow(m, r);
      m.example = false;
    });
    setPasteText("");
    setPasteOpen(false);
  }

  async function copyText() {
    if (!map) return;
    try {
      await navigator.clipboard.writeText(toPatchList(map));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — the text is still visible in the paste panel */
    }
  }

  if (!map) {
    return (
      <div className="page routing-page">
        <header className="page-head">
          <h1>Routing</h1>
        </header>
        {routing.loadErr ? (
          <div className="banner">
            routing.json is there but can't be read: {routing.loadErr}. Nothing will be written over it. Fix or remove the file, then reopen this page.
          </div>
        ) : (
          <p className="muted small">Loading the map…</p>
        )}
      </div>
    );
  }

  const staleAt = map.verified?.at;
  const stale = !staleAt || now - staleAt > STALE_AFTER_MS;
  const pasted = pasteOpen ? parsePatchList(pasteText) : null;

  return (
    <div className="page routing-page">
      <header className="page-head">
        <h1>Routing</h1>
        <div className="rt-tabs" role="tablist">
          <button className={tab === "channels" ? "on" : ""} onClick={() => setTab("channels")}>
            Channels
          </button>
          <button className={tab === "walk" ? "on" : ""} onClick={() => setTab("walk")}>
            No sound?
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {tab === "channels" && CAN_EDIT && !editing && (
          <button className="btn small ghost" onClick={() => setDraft(clone(map))}>
            Edit
          </button>
        )}
        {tab === "channels" && editing && (
          <>
            <button className="btn small ghost" onClick={cancel}>
              Cancel
            </button>
            <button className="btn small primary" onClick={save}>
              Save
            </button>
          </>
        )}
      </header>

      {routing.saveErr && <div className="banner">Couldn't save: {routing.saveErr}</div>}
      {routing.migrated && editing && (
        <div className="banner rt-note">
          Converted from the old Routing chains. Every hop and its steps are here as nodes with guessed kinds — look it over, then <strong>Save</strong> to keep it.
        </div>
      )}
      {map.example && (
        <div className="banner rt-note">
          <strong>This is the example map</strong> that ships with ProDeck — a sixteen-channel church that isn't yours. Press Edit, then <strong>Paste patch list</strong> with your own channels, and it is replaced.
        </div>
      )}

      {tab === "walk" && (
        <div className="card rt-walk-card">
          {!walkTarget && (
            <p className="muted small routing-intro">
              Pick a person, a channel or a place. ProDeck checks what it can see from here — the desk, its own inputs — then lists what is left to walk to, most likely first.
            </p>
          )}
          {!walkTarget && <WalkPicker map={map} live={live} onPick={setWalkTarget} />}
          {walkTarget && <WalkView map={map} live={live} targetId={walkTarget} onBack={() => setWalkTarget(null)} onPick={setWalkTarget} />}
        </div>
      )}

      {tab === "channels" && (
        <>
          <p className="muted small routing-intro">
            Every console channel, the door it comes in through, the socket on that door, and what is upstream of the socket. Names fill in from the desk; typing one here only overrides it.
          </p>

          <div className="rt-toolbar">
            <span className={`rt-age ${stale ? "stale" : ""}`}>Map {ageText(staleAt, now)}</span>
            {editing && (
              <>
                <button className="btn small ghost" onClick={() => setPasteOpen((v) => !v)}>
                  Paste patch list
                </button>
                <button className="btn small ghost" onClick={verifyAll} title="Stamp every row as checked today">
                  Mark all verified
                </button>
              </>
            )}
            <button className="btn small ghost" onClick={copyText}>
              {copied ? "Copied" : "Copy as text"}
            </button>
          </div>

          {pasteOpen && editing && (
            <div className="card rt-paste">
              <p className="muted small">
                One channel per line: <span className="mono">CH · NAME · PORT · SOCKET · UPSTREAM</span>, separated by tabs (straight from a spreadsheet) or commas. A header row is fine. Existing channels with the same number are updated; their steps and notes are kept.
              </p>
              <textarea
                id="rt-paste"
                className="input rt-paste-text"
                rows={8}
                placeholder={"39\tvox 3\tI/O Port 1\t43\tULXD4Q-5-8 07\n1\tKick IN\tSLink\t1\tstage 1"}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <div className="rt-paste-foot">
                <span className="muted small">
                  {pasted && pasted.rows.length > 0 ? `${pasted.rows.length} channel${pasted.rows.length === 1 ? "" : "s"} ready` : "Nothing recognised yet"}
                  {pasted && pasted.skipped.length > 0 ? ` · ${pasted.skipped.length} line${pasted.skipped.length === 1 ? "" : "s"} skipped` : ""}
                </span>
                <button className="btn small primary" disabled={!pasted || pasted.rows.length === 0} onClick={applyPaste}>
                  Apply
                </button>
              </div>
            </div>
          )}

          <div className="card rt-table-card">
            <table className="rt-table">
              <thead>
                <tr>
                  <th className="n">CH</th>
                  <th>Name</th>
                  <th>Port</th>
                  <th className="n">Socket</th>
                  <th>Upstream</th>
                  <th>Live</th>
                  <th className="n">Checked</th>
                  {editing && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <RowView
                    key={r.nodeId}
                    r={r}
                    map={map}
                    live={live}
                    editing={editing}
                    open={open === r.nodeId}
                    onToggle={() => setOpen(open === r.nodeId ? null : r.nodeId)}
                    onChange={(patch) => mutate((m) => void applyRow(m, { ch: r.ch, name: r.name, port: r.doorLabel, socket: r.socket, upstream: r.upstream, ...patch }))}
                    onRemove={() => mutate((m) => removeChannel(m, r.nodeId))}
                    onVerify={() =>
                      mutate((m) => {
                        const at = Date.now();
                        const n = node(m, r.nodeId);
                        if (n) n.verified = at;
                        for (const e of edgesInto(m, r.nodeId)) {
                          e.verified = at;
                          const d = node(m, e.from);
                          if (d) d.verified = at;
                          for (const up of edgesInto(m, e.from).filter((x) => x.at === e.at)) {
                            up.verified = at;
                            const s = node(m, up.from);
                            if (s) s.verified = at;
                          }
                        }
                      })
                    }
                    onSteps={(nodeId, steps) =>
                      mutate((m) => {
                        const n = node(m, nodeId);
                        if (n) n.steps = steps.length ? steps : undefined;
                      })
                    }
                    onDead={(nodeId, dead) =>
                      mutate((m) => {
                        const n = node(m, nodeId);
                        if (n) n.dead = dead || undefined;
                      })
                    }
                    onWalk={() => {
                      setWalkTarget(r.nodeId);
                      setTab("walk");
                    }}
                  />
                ))}
                {editing && <AddRow onAdd={(ch) => mutate((m) => void applyRow(m, { ch, name: "" }))} taken={rows.map((r) => r.ch)} />}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted small" style={{ marginTop: 10 }}>No channels yet. Press Edit, then Paste patch list.</p>}
          </div>

          {map.watchlist.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Things to watch</h3>
              </div>
              <ul className="rt-watchlist">
                {map.watchlist.map((w) => (
                  <li key={w.id} className={w.severity}>
                    <span className="mono rt-watch-sev">{w.severity === "fix" ? "worth fixing" : "deliberate"}</span>
                    <div>
                      <strong>{w.symptom}</strong>
                      <div className="muted small">{w.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ rows */

function RowView({
  r,
  map,
  live,
  editing,
  open,
  onToggle,
  onChange,
  onRemove,
  onVerify,
  onSteps,
  onDead,
  onWalk,
}: {
  r: ChannelRow;
  map: RoutingMap;
  live: ReturnType<typeof useRoutingLive>;
  editing: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: { name?: string; port?: string; socket?: string; upstream?: string }) => void;
  onRemove: () => void;
  onVerify: () => void;
  onSteps: (nodeId: string, steps: string[]) => void;
  onDead: (nodeId: string, dead: boolean) => void;
  onWalk: () => void;
}) {
  const n = node(map, r.nodeId)!;
  const key = deskKeyFor(n);
  const desk = live.desk?.connected ? live.desk : null;
  const deskName = key && desk ? (desk.names[key] ?? "").trim() : "";
  const muted = key && desk ? desk.mutes[key] === true : false;
  const fader = key && desk ? desk.faders[key] : undefined;
  const src = r.upstreamId ? node(map, r.upstreamId) : undefined;
  const stale = !r.verified || live.now - r.verified > STALE_AFTER_MS;
  const doorT = (r.door ? node(map, r.door)?.transport : "") ?? "";

  return (
    <>
      <tr className={`rt-row ${open ? "open" : ""} ${src?.dead ? "dead" : ""}`} onClick={editing ? undefined : onToggle}>
        <td className="n mono">{r.ch}</td>
        <td>
          {editing ? (
            <input className="input rt-cell" value={r.name} placeholder={deskName || "name"} onChange={(e) => onChange({ name: e.target.value })} />
          ) : (
            <span className={r.name ? "" : "muted"}>{r.name || deskName || "—"}</span>
          )}
          {!editing && r.name && deskName && deskName !== r.name && <span className="rt-deskname muted small"> “{deskName}” on the desk</span>}
        </td>
        <td>
          {editing ? (
            <select className="input rt-cell" value={doorT} onChange={(e) => onChange({ port: e.target.value ? DOOR_LABELS[e.target.value as Transport] : "" })}>
              {PORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : r.doorLabel ? (
            <span className={`rt-port ${doorT}`}>{r.doorLabel}</span>
          ) : (
            <span className="muted">not patched</span>
          )}
        </td>
        <td className="n mono">
          {editing ? <input className="input rt-cell rt-cell-n" value={r.socket} onChange={(e) => onChange({ socket: e.target.value })} /> : r.socket || "—"}
          {!editing && r.twins.length > 0 && <span className="rt-twin" title={`Shares this socket — and its gain — with channel ${r.twins.join(", ")}`}>+{r.twins.join(",")}</span>}
        </td>
        <td>
          {editing ? (
            <input className="input rt-cell" value={r.upstream} placeholder="stage 41 · ULXD4Q-5-8 07 · MacBook 05" onChange={(e) => onChange({ upstream: e.target.value })} />
          ) : (
            <span className={r.upstream ? "" : "muted"}>
              {r.upstream || "—"}
              {src?.dead && <span className="rt-dead"> dead socket</span>}
            </span>
          )}
        </td>
        <td>
          {key && desk ? (
            muted ? (
              <span className="rt-live bad">muted</span>
            ) : (
              <span className="rt-live ok">open{typeof fader === "number" && fader > -Infinity ? ` ${fader >= 0 ? "+" : "−"}${Math.abs(Math.round(fader))}` : ""}</span>
            )
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className={`n small ${stale ? "muted" : ""}`}>
          {r.verified ? ageText(r.verified, live.now).replace("verified ", "") : "—"}
          {editing && (
            <button className="btn small ghost rt-verify" onClick={onVerify} title="I checked this row today">
              ✓
            </button>
          )}
        </td>
        {editing && (
          <td className="n">
            <button className="rt-icon" onClick={onToggle} title="Steps for this channel">
              …
            </button>
            <button className="rt-icon" onClick={onRemove} title="Remove channel">
              ×
            </button>
          </td>
        )}
      </tr>
      {open && (
        <tr className="rt-detail">
          <td colSpan={editing ? 8 : 7}>
            <div className="rt-detail-grid">
              {src && (
                <StepsBox
                  title={`When ${src.label} is the suspect`}
                  steps={stepsFor(map, src)}
                  own={!!src.steps?.length}
                  editing={editing}
                  onSave={(s) => onSteps(src.id, s)}
                  extra={
                    editing ? (
                      <label className="rt-deadbox small">
                        <input type="checkbox" checked={!!src.dead} onChange={(e) => onDead(src.id, e.target.checked)} /> Dead — looks normal, goes nowhere
                      </label>
                    ) : null
                  }
                />
              )}
              <StepsBox title={`When channel ${r.ch} is the suspect`} steps={stepsFor(map, n)} own={!!n.steps?.length} editing={editing} onSave={(s) => onSteps(n.id, s)} />
              {!editing && (
                <div className="rt-detail-actions">
                  <button className="btn small primary" onClick={onWalk}>
                    Walk this channel
                  </button>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function StepsBox({
  title,
  steps,
  own,
  editing,
  onSave,
  extra,
}: {
  title: string;
  steps: string[];
  own: boolean;
  editing: boolean;
  onSave: (steps: string[]) => void;
  extra?: React.ReactNode;
}) {
  const [text, setText] = useState(steps.join("\n"));
  useEffect(() => setText(steps.join("\n")), [steps]);
  return (
    <div className="rt-stepsbox">
      <div className="rt-stepsbox-head">
        <strong>{title}</strong>
        {!own && <span className="muted small"> · template for this kind{editing ? " — edit to make it yours" : ""}</span>}
      </div>
      {editing ? (
        <>
          <textarea
            className="input routing-steps-edit"
            rows={Math.max(3, steps.length + 1)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => onSave(text.split("\n").map((s) => s.trim()).filter(Boolean))}
          />
          {extra}
        </>
      ) : (
        <ol>
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AddRow({ onAdd, taken }: { onAdd: (ch: string) => void; taken: string[] }) {
  const [ch, setCh] = useState("");
  const ok = /^\d+(\s*[-+–]\s*\d+)?$/.test(ch.trim()) && !taken.includes(ch.trim());
  return (
    <tr className="rt-add">
      <td className="n">
        <input className="input rt-cell rt-cell-n" placeholder="CH" value={ch} onChange={(e) => setCh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && (onAdd(ch.trim()), setCh(""))} />
      </td>
      <td colSpan={7}>
        <button
          className="btn small ghost"
          disabled={!ok}
          onClick={() => {
            onAdd(ch.trim());
            setCh("");
          }}
        >
          Add channel
        </button>
        <span className="muted small"> — a number, or a stereo range like 11-12</span>
      </td>
    </tr>
  );
}
