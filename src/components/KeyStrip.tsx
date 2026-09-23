import { useEffect, useState } from "react";
import { IS_WEB, keysendRequest, keysendState, on, type KeySendState } from "../lib/tauri";
import { KEY_CHOICES, keyToProgram, pitchClassName, programName } from "../lib/keySend";
import { usePerms } from "../lib/perms";
import { fmtSince } from "../lib/deskConfidence";

// Song Key → Waves, surfaced. What the live song's key is, what was last sent
// to the rig and when, whether the MIDI link is up — and the thirteen buttons
// (twelve keys + Tune off) to send one by hand. On the booth a press goes
// straight to the key-send loop; on a phone it asks the booth through the
// gateway (Control permission). Same component in the ProPresenter transport
// (compact) and as a dashboard widget.

export function useKeySendState(): KeySendState | null {
  const [st, setSt] = useState<KeySendState | null>(null);
  useEffect(() => {
    let alive = true;
    keysendState()
      .then((s) => alive && setSt(s))
      .catch(() => {});
    const un = on<KeySendState>("keysend:state", (s) => alive && setSt(s));
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);
  return st;
}

export function sendKeyNow(key: string) {
  if (IS_WEB) return keysendRequest(key);
  window.dispatchEvent(new CustomEvent("prodeck:sendkey", { detail: { key } }));
  return Promise.resolve();
}

export function KeyStrip({ compact }: { compact?: boolean }) {
  const st = useKeySendState();
  const { can } = usePerms();
  const [err, setErr] = useState("");
  const canSend = !IS_WEB || can("control");
  if (!st || !st.enabled) return null;

  const livePc = keyToProgram(st.liveKey);
  const sentPc = st.lastProgram;
  const inSync = livePc != null && sentPc != null && livePc === sentPc;
  const link = st.midiConnected ? "MIDI up" : st.oscHost ? "OSC only" : "no link";

  const send = async (key: string) => {
    setErr("");
    try {
      await sendKeyNow(key);
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className={`ks ${compact ? "compact" : ""}`}>
      <div className="ks-status">
        <span className="ks-label mono">Waves key</span>
        <span className={`ks-sent ${sentPc == null ? "none" : inSync ? "ok" : "warn"}`} title={st.lastAt ? `Sent ${fmtSince(st.lastAt, Date.now())}${st.lastBy ? ` by ${st.lastBy}` : ""}` : "Nothing sent yet"}>
          {sentPc == null ? "—" : programName(sentPc)}
        </span>
        {st.liveKey && (
          <span className="ks-live muted" title="The live song's key from Planning Center or your override">
            song {st.liveKey}
            {st.liveSong ? ` · ${st.liveSong}` : ""}
            {livePc != null && sentPc != null && !inSync ? " · not sent yet" : ""}
          </span>
        )}
        <span className={`chip ${st.midiConnected ? "online" : st.oscHost ? "" : "warn"}`} title={st.midiPort ? `MIDI port ${st.midiPort}` : "No MIDI port chosen"}>
          {link}
        </span>
      </div>
      {canSend && (
        <div className="ks-keys" role="group" aria-label="Send a key to the rig">
          {KEY_CHOICES.map((k) => {
            const p = keyToProgram(k)!;
            const isSent = sentPc === p;
            const isLive = livePc === p;
            return (
              <button
                key={k}
                className={`ks-key ${isSent ? "sent" : ""} ${isLive ? "live" : ""} ${p === 12 ? "off" : ""}`}
                title={p === 12 ? "Tune off — the rig's thirteenth scene" : `Send ${pitchClassName(p)} (program ${p})`}
                onClick={() => send(k)}
              >
                {p === 12 ? "Tune off" : pitchClassName(p)}
              </button>
            );
          })}
        </div>
      )}
      {err && <div className="ks-err">{err}</div>}
    </div>
  );
}
