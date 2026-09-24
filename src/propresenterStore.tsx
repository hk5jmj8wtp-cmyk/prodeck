import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useProDeck, type PpStatus } from "./store";
import { createPpClient, getSettings, IS_WEB, on, updateSettings, type Json, type ProPresenterInstance } from "./lib/tauri";

const clients = { 1: createPpClient(1), 2: createPpClient(2) };
const Instance = createContext<ProPresenterInstance>(1);
export function ProPresenterScope({ instance, children }: { instance: ProPresenterInstance; children: ReactNode }) {
  return <Instance.Provider value={instance}>{children}</Instance.Provider>;
}
export const usePpInstance = () => useContext(Instance);
export const usePpClient = () => clients[usePpInstance()];
const empty: PpStatus = { layers: null, slideIndex: null, activePresentation: null, activeAnnouncement: null, currentTimers: null, currentLook: null, stageMessage: null };
const streamKeys: Record<string, keyof PpStatus> = {
  layers: "layers", slide_index: "slideIndex", active_presentation: "activePresentation",
  active_announcement: "activeAnnouncement", current_timers: "currentTimers", current_look: "currentLook", stage_message: "stageMessage",
};
type Connection = {
  connected: boolean; host: string; status: PpStatus; connectError: string; ppConnecting: boolean;
  connect: (host: string, port: number) => Promise<void>; disconnect: () => Promise<void>;
};
const Secondary = createContext<Connection | null>(null);

export function ProPresenter2Provider({ children }: { children: ReactNode }) {
  const { settings, refreshSettings } = useProDeck();
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<PpStatus>(empty);
  const [connectError, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [failures, setFailures] = useState(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const enabled = useRef(false);
  const refs = useRef({ settings, connected });
  refs.current = { settings, connected };
  useEffect(() => { enabled.current = !!settings?.pp2_auto_connect; }, [settings?.pp2_auto_connect]);

  useEffect(() => {
    let disposed = false;
    const subscriptions = Promise.all([
      on<{ host?: string; port?: number }>("pp2:connected", (cfg) => {
        setConnected(true); setError(""); setFailures(0);
        if (cfg?.host) setHost(`${cfg.host}:${cfg.port}`);
      }),
      on("pp2:disconnected", () => { setConnected(false); setStatus(empty); }),
      on<{ stream: string; data: Json }>("pp2:status", ({ stream, data }) => {
        const key = streamKeys[stream];
        if (key) setStatus((prev) => ({ ...prev, [key]: data }));
      }),
    ]);
    subscriptions.then(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; subscriptions.then((off) => off.forEach((f) => f())); };
  }, []);

  async function dial(h: string, port: number) {
    if (inFlight.current) return inFlight.current;
    setBusy(true); setError("");
    const task = (async () => {
      try {
        await clients[2].ppConnect({ host: h.trim(), port });
        setConnected(true); setFailures(0);
      } catch (e) {
        setError(String(e)); setFailures((n) => n + 1); throw e;
      } finally { setBusy(false); inFlight.current = null; }
    })();
    inFlight.current = task;
    return task;
  }
  async function connect(h: string, port: number) {
    if (!h.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      const message = "Enter the second computer’s address and a port from 1 to 65535.";
      setError(message); throw new Error(message);
    }
    // Wait for an automatic attempt before accepting a new manual target.
    await inFlight.current?.catch(() => {});
    await dial(h, port);
    enabled.current = true;
    const s = await getSettings();
    await updateSettings({ ...s, pp2_host: h.trim(), pp2_port: port, pp2_auto_connect: true });
    await refreshSettings();
  }
  async function disconnect() {
    enabled.current = false;
    await inFlight.current?.catch(() => {});
    await clients[2].ppDisconnect();
    setConnected(false); setStatus(empty);
    const s = await getSettings();
    await updateSettings({ ...s, pp2_auto_connect: false });
    await refreshSettings();
  }
  useEffect(() => {
    if (IS_WEB || !ready) return;
    const retry = () => {
      const { settings: s, connected: up } = refs.current;
      if (!enabled.current || !s?.pp2_host || up || inFlight.current) return;
      // Always retry the configured computer. Never adopt a different booth's
      // ProPresenter just because it was the first Bonjour result.
      void dial(s.pp2_host, s.pp2_port).catch(() => {});
    };
    retry();
    const timer = setInterval(retry, 6000);
    return () => clearInterval(timer);
  }, [ready, settings?.pp2_host, settings?.pp2_port, settings?.pp2_auto_connect]);

  return <Secondary.Provider value={{ connected, host, status, connectError, connect, disconnect,
    ppConnecting: busy || (!connected && !!settings?.pp2_host && !!settings?.pp2_auto_connect && failures < 5),
  }}>{children}</Secondary.Provider>;
}

export function usePpConnection(instanceOverride?: ProPresenterInstance) {
  const primary = useProDeck();
  const secondary = useContext(Secondary);
  const scope = usePpInstance();
  const instance = instanceOverride ?? scope;
  if (instance === 2 && !secondary) throw new Error("propresenter 2 provider is missing");
  return {
    ...(instance === 2 ? secondary! : primary),
    label: instance === 2 ? "propresenter 2" : "ProPresenter",
    savedHost: instance === 2 ? primary.settings?.pp2_host ?? "" : primary.settings?.pp_host ?? "localhost",
    savedPort: instance === 2 ? primary.settings?.pp2_port ?? 1025 : primary.settings?.pp_port ?? 1025,
  };
}
