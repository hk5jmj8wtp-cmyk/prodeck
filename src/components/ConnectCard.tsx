import { useEffect, useState } from "react";
import { usePpConnection } from "../propresenterStore";
import {
  diagLocalNetwork,
  discoverServices,
  IS_WEB,
  openLocalNetworkSettings,
  type DiscoveredService,
  type LocalNetworkReport,
} from "../lib/tauri";
import { Icon } from "./Icon";

export function ConnectCard() {
  const { connected, host: connectedHost, connect, disconnect, connectError, savedHost, savedPort, label, ppConnecting } =
    usePpConnection();
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(1025);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredService[]>([]);
  const [scanned, setScanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [lanReport, setLanReport] = useState<LocalNetworkReport | null>(null);

  // Once the automatic retries have given up, find out WHY before blaming the
  // network. The one cause that looks like everything else is macOS having
  // revoked local-network access: Planning Center keeps working, so nobody
  // suspects a permission.
  useEffect(() => {
    if (IS_WEB || connected || ppConnecting) {
      setLanReport(null);
      return;
    }
    let stale = false;
    diagLocalNetwork()
      .then((r) => {
        if (!stale) setLanReport(r);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [connected, ppConnecting]);

  useEffect(() => {
    setHost(savedHost);
    setPort(savedPort);
  }, [savedHost, savedPort]);

  // Choose the most reliable host from a discovered service: IPv4 first, then
  // the .local hostname (resolves via mDNS on macOS), then any address.
  function bestHost(s: DiscoveredService): string {
    const ipv4 = s.addresses.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
    if (ipv4) return ipv4;
    if (s.host) return s.host;
    return s.addresses[0] ?? "";
  }

  async function scan() {
    setScanning(true);
    try {
      const services = await discoverServices(4);
      setFound(services.filter((s) => s.kind === "propresenter" || s.kind === "stage"));
      setScanned(true);
    } finally {
      setScanning(false);
    }
  }

  async function doConnect() {
    setBusy(true);
    try {
      await connect(host, port);
    } catch {
      /* surfaced via connectError */
    } finally {
      setBusy(false);
    }
  }

  if (connected) {
    return (
      <div className="card connect-card">
        <div className="card-head">
          <h3>{label}</h3>
          <span className="chip online">Connected</span>
        </div>
        <p className="muted">{connectedHost}</p>
        <button className="btn ghost" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  // Browsers can't drive the connection at all (pp_connect is host-only) —
  // say that in words instead of leaking the raw dispatch error.
  if (IS_WEB) {
    return (
      <div className="card connect-card">
        <div className="card-head">
          <h3>{label}</h3>
          <span className="chip">Not connected</span>
        </div>
        <p className="muted">
          ProPresenter connects from the Mac running ProDeck, not from a
          browser — this view is along for the ride. Once that Mac connects, the
          live widgets here light up on their own.
        </p>
      </div>
    );
  }

  // Still trying on its own. Say so, and stay out of the way — the retry loop
  // in the store reaches ProPresenter by itself within a few seconds of a
  // restart, and the page that greeted people with "unreachable / firewalled"
  // in the meantime was describing a problem that did not exist.
  if (ppConnecting) {
    return (
      <div className="card connect-card">
        <div className="card-head">
          <h3>{label}</h3>
          <span className="chip">Connecting…</span>
        </div>
        <p className="muted">
          Reaching {savedHost || label} — this usually takes a
          few seconds after ProDeck starts.
        </p>
        <button className="btn ghost small" onClick={scan} disabled={scanning}>
          <Icon name="search" size={13} />
          {scanning ? "Looking…" : "Find it on the network instead"}
        </button>
      </div>
    );
  }

  return (
    <div className="card connect-card">
      <div className="card-head">
        <h3>Connect to {label}</h3>
      </div>

      {/* Finding it is the happy path; typing an IP is the fallback. */}
      <button className="btn primary" onClick={scan} disabled={scanning}>
        <Icon name="search" size={14} />
        {scanning ? "Looking for ProPresenter…" : "Find ProPresenter on this network"}
      </button>
      {scanned && !scanning && found.length === 0 && (
        <p className="muted small">
          Nothing found. Make sure ProPresenter is open and its network API is
          on (Preferences → Network → Enable Network), then try again — or
          enter the address by hand below.
        </p>
      )}

      {found.length > 0 && (
        <div className="discovered">
          {found.map((s) => (
            <button
              key={`${s.name}-${s.kind}-${s.port}`}
              className="discovered-item"
              disabled={busy}
              onClick={async () => {
                // Use the port the service actually advertises — the host sets
                // it, not us. Fill the fields and connect straight away.
                const h = bestHost(s);
                setHost(h);
                setPort(s.port);
                setBusy(true);
                try {
                  await connect(h, s.port);
                } catch {
                  /* surfaced via connectError */
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="dot online" />
              <span className="d-name">{s.name}</span>
              <span className={`d-kind ${s.kind}`}>
                {s.kind === "propresenter" ? "API" : "Stage"}
              </span>
              <span className="d-meta">{bestHost(s) + ":" + s.port}</span>
            </button>
          ))}
        </div>
      )}

      <button
        className="btn small ghost"
        style={{ marginTop: 10 }}
        onClick={() => setAdvanced((v) => !v)}
      >
        {advanced ? "▾" : "▸"} Enter address manually
      </button>
      {advanced && (
        <>
          <div className="field-row" style={{ marginTop: 8 }}>
            <input
              className="input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Host / IP"
            />
            <input
              className="input port"
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 0)}
              placeholder="Port"
            />
          </div>
          <button className="btn" onClick={doConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
          <p className="hint">
            The address is on the ProPresenter Mac under Preferences → Network
            (default port 1025).
          </p>
        </>
      )}
      {/* The specific diagnosis beats the generic error. Shown instead of it,
          because "unreachable / firewalled" actively misdirects here. */}
      {lanReport?.likely_blocked ? (
        <div className="lan-blocked">
          <strong>macOS is blocking ProDeck from your local network.</strong>
          <p>
            Planning Center still works, so the machine is online — but nothing
            in the building is reachable: {lanReport.lan.map((t) => t.label).join(", ")}.
            That is a macOS privacy permission, not your network. It can switch
            itself off when ProDeck updates.
          </p>
          <button className="btn primary" onClick={() => openLocalNetworkSettings()}>
            Open Local Network settings
          </button>
          <p className="hint">
            Turn <strong>ProDeck</strong> on in that list. Everything reconnects on its own
            within a few seconds — no restart needed.
          </p>
        </div>
      ) : (
        connectError && !ppConnecting && <p className="error">{connectError}</p>
      )}
    </div>
  );
}
