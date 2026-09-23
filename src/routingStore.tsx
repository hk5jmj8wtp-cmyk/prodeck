import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAlerts } from "./alertsStore";
import { avantisState, IS_WEB, loadRouting, on, saveRouting, type AvantisSnapshot, type Json } from "./lib/tauri";
import { exampleMap, normalizeMap, type LiveView, type RoutingMap } from "./lib/routing";
import { confirmedMutes } from "./lib/deskConfidence";

// The routing map: loaded once, shared by the Routing page, the walk on the
// booth and the walk on every phone. The booth owns routing.json; web clients
// read it and never write (same rule as every other file).

interface RoutingCtx {
  map: RoutingMap | null;
  /** routing.json exists but could not be read. Nothing is written until it can. */
  loadErr: string;
  saveErr: string;
  /** Converted from the schema-1 chains this session; not yet written back. */
  migrated: boolean;
  save: (next: RoutingMap) => Promise<void>;
  /** Re-read routing.json — phones call this when the booth announces a change. */
  reload: () => void;
}

const Ctx = createContext<RoutingCtx | null>(null);

export function RoutingProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<RoutingMap | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [migrated, setMigrated] = useState(false);

  const reload = useCallback(() => {
    loadRouting()
      .then((raw) => {
        const l = normalizeMap(raw);
        // A missing file seeds the example. An unreadable one is an error and
        // stays one — seeding here is how a church's map got overwritten once.
        setMap(l ? l.map : exampleMap());
        setMigrated(!!l?.migrated);
        setLoadErr("");
      })
      .catch((e) => setLoadErr(String(e)));
  }, []);

  useEffect(() => {
    reload();
    // Web clients learn about booth edits the same way every store does.
    const un = on("routing:changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  const save = useCallback(
    async (next: RoutingMap) => {
      if (loadErr) return;
      const clean: RoutingMap = { ...next, example: false };
      setMap(clean);
      setMigrated(false);
      if (IS_WEB) return;
      try {
        await saveRouting(clean as unknown as Json);
        setSaveErr("");
      } catch (e) {
        setSaveErr(String(e));
      }
    },
    [loadErr],
  );

  const value = useMemo<RoutingCtx>(() => ({ map, loadErr, saveErr, migrated, save, reload }), [map, loadErr, saveErr, migrated, save, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRouting(): RoutingCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRouting must be used within RoutingProvider");
  return c;
}

/**
 * What ProDeck can see right now, shaped for the walk engine: the desk
 * mirror (mutes, faders, names — the same keys for every supported desk),
 * per-channel peaks from the booth's own audio input, and the subsystem
 * lights for maps imported from the old chains.
 */
export function useRoutingLive(): LiveView {
  const { subsystems } = useAlerts();
  const [desk, setDesk] = useState<AvantisSnapshot | null>(null);
  const pendingDesk = useRef<AvantisSnapshot | null>(null);
  const capture = useRef<{ peaks: number[]; at: number } | null>(null);
  const [tickN, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    avantisState()
      .then((s) => alive && setDesk(s))
      .catch(() => {});
    // The mirror can emit several times a second during a fader ride. Hold
    // the latest and publish it on the tick below, so the map repaints at a
    // human rate, not a MIDI rate.
    const unState = on<AvantisSnapshot>("avantis:state", (s) => {
      pendingDesk.current = s;
    });
    const unStatus = on<{ connected: boolean }>("avantis:status", (s) => {
      if (alive && !s.connected) setDesk((d) => (d ? { ...d, connected: false } : d));
    });
    const unChans = on<number[]>("audio:channels", (peaks) => {
      capture.current = { peaks, at: Date.now() };
    });
    // One repaint a second is plenty for a ✓ to appear when a pack is
    // switched on. Consumers compare what changed and skip the rest.
    const iv = setInterval(() => {
      if (!alive) return;
      if (pendingDesk.current) {
        const next = pendingDesk.current;
        pendingDesk.current = null;
        setDesk((d) => (d && JSON.stringify(d) === JSON.stringify(next) ? d : next));
      }
      tick((n) => n + 1);
    }, 1000);
    return () => {
      alive = false;
      clearInterval(iv);
      unState.then((f) => f());
      unStatus.then((f) => f());
      unChans.then((f) => f());
    };
  }, []);

  const subs = useMemo(() => Object.fromEntries(subsystems.map((s) => [s.key, s.state])), [subsystems]);

  // The mirror reports faders as MIDI 0–127; the walk thinks in dB.
  const deskView = useMemo(() => {
    if (!desk) return null;
    const faders: Record<string, number> = {};
    for (const [k, v] of Object.entries(desk.faders ?? {})) faders[k] = v === 0 ? -Infinity : (v / 127) * 64 - 54;
    return { connected: desk.connected, mutes: desk.mutes ?? {}, confirmed: confirmedMutes(desk), faders, names: desk.names ?? {}, scene: desk.scene ?? null };
  }, [desk]);

  // A new object only when something it holds has actually changed (or the
  // clock ticked). Memoised consumers can then key off identity.
  return useMemo(
    () => ({ desk: deskView, capture: capture.current, subsystems: subs, now: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deskView, subs, tickN],
  );
}
