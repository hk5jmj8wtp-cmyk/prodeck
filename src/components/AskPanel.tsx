import { useEffect, useMemo, useRef, useState } from "react";
import { usePco } from "../pcoStore";
import { useProDeck } from "../store";
import { usePerms } from "../lib/perms";
import { assistComplete, assistStatus, IS_WEB, loadKnowledge, type AssistStatus } from "../lib/tauri";
import { ask, cites as citesOf, type AssistCtx, type AssistPerson, type Msg } from "../lib/assist";
import { useWalkPeople } from "./RoutingWalk";
import type { LiveView, RoutingMap } from "../lib/routing";

// "Ask ProDeck" — the chat face of the troubleshooter. Same component on the
// booth and on a phone. It only renders when the booth has a key and this
// tier is allowed to ask; otherwise the deterministic picker is all there is.

export function AskPanel({ map, live, onPick, compact }: { map: RoutingMap; live: LiveView; onPick: (nodeId: string) => void; compact?: boolean }) {
  const [status, setStatus] = useState<AssistStatus | null>(null);
  const [knowledge, setKnowledge] = useState<{ name: string; text: string }[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; text: string; cites?: { label: string; nodeId: string }[] }[]>([]);
  const history = useRef<Msg[]>([]);
  const pco = usePco();
  const pd = useProDeck();
  const { isAdmin } = usePerms();
  const people = useWalkPeople(map);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    assistStatus().then(setStatus).catch(() => setStatus(null));
    loadKnowledge().then(setKnowledge).catch(() => {});
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length, busy]);

  const ctx = useMemo<AssistCtx | null>(() => {
    if (!status?.configured) return null;
    const ppl: AssistPerson[] = people.map((p) => ({ name: p.name, position: p.position, mic: p.mic, channelIds: p.nodes.map((n) => n.id) }));
    const plan = pco.plans?.find((p) => p.id === pco.selectedPlanId);
    return {
      map,
      live,
      people: ppl,
      status: { deskConnected: !!live.desk?.connected, ppConnected: !!pd.connected, meterRunning: !!pd.audioRunning, service: plan?.title ? `${plan.title} (${plan.date})` : undefined },
      knowledge,
      asker: IS_WEB ? "phone" : "booth",
    };
  }, [status, people, map, live, pd.connected, pd.audioRunning, knowledge, pco.plans, pco.selectedPlanId]);

  if (!status?.configured) return null;
  if (!isAdmin && !status.members) return null;

  async function send() {
    const question = q.trim();
    if (!question || busy || !ctx) return;
    setQ("");
    setErr("");
    setTurns((t) => [...t, { role: "user", text: question }]);
    setBusy(true);
    try {
      const r = await ask(ctx, history.current, question, (body) => assistComplete(body));
      const turn: Msg[] = [{ role: "user", content: question }, { role: "assistant", content: r.text }];
      history.current = [...history.current, ...turn].slice(-12);
      setTurns((t) => [...t, { role: "assistant", text: r.text, cites: r.cites.length ? r.cites : citesOf(ctx, r.text) }]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`ask ${compact ? "compact" : ""}`}>
      <div className="ask-head">
        <span className="ask-title">Ask ProDeck</span>
        <span className="ask-sub">
          Describe what's wrong in your own words. It answers only from this building's map and notes.
        </span>
      </div>
      {turns.length > 0 && (
        <div className="ask-turns">
          {turns.map((t, i) => (
            <div key={i} className={`ask-turn ${t.role}`}>
              <div className="ask-bubble">{renderText(t.text)}</div>
              {t.cites && t.cites.length > 0 && (
                <div className="ask-cites">
                  {t.cites.map((c) => (
                    <button key={c.nodeId} className="ask-cite" onClick={() => onPick(c.nodeId)}>
                      {c.label} →
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="ask-turn assistant">
              <div className="ask-bubble ask-thinking">Looking at the map…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
      {err && <div className="ask-err">{err}</div>}
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          id="ask-input"
          className="ask-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={turns.length ? "Say what happened next…" : "e.g. Ruth's mic is crackling · nothing from the keys · stream is quiet"}
          disabled={busy}
          autoComplete="off"
        />
        <button className="ask-send" type="submit" disabled={busy || !q.trim()}>
          Ask
        </button>
      </form>
      {turns.length > 0 && (
        <button
          className="ask-reset"
          onClick={() => {
            setTurns([]);
            history.current = [];
          }}
        >
          Start over
        </button>
      )}
    </section>
  );
}

/** Minimal rendering: paragraphs, numbered / bulleted lines, **bold**. */
function renderText(text: string) {
  const lines = text.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? "ol" : "ul";
    out.push(<L key={out.length}>{list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}</L>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const num = /^(\d+)[.)]\s+(.*)$/.exec(line);
    const bul = /^[-*•]\s+(.*)$/.exec(line);
    if (num || bul) {
      const ordered = !!num;
      const item = (num ? num[2] : bul![1]).trim();
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }
    flush();
    out.push(<p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return out;
}

function inline(s: string) {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
}
