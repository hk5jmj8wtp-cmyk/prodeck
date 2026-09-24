import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  settings: { pp_host: "first.local", pp_port: 1025, pp_auto_connect: true, pp2_host: "second.local", pp2_port: 1026, pp2_auto_connect: true },
  listeners: new Map<string, (value: any) => void>(),
  clear: vi.fn(), dial: vi.fn(), disconnect: vi.fn(), refresh: vi.fn(), update: vi.fn(),
}));
vi.mock("./store", () => ({ useProDeck: () => ({
  connected: true, host: "first.local:1025", status: { currentLook: "first look" },
  settings: mock.settings, refreshSettings: mock.refresh,
}) }));
vi.mock("./lib/tauri", () => ({
  IS_WEB: false,
  createPpClient: (instance: number) => ({
    ppClearLayer: (layer: string) => mock.clear(instance, layer),
    ppConnect: (config: any) => mock.dial(instance, config),
    ppDisconnect: () => mock.disconnect(instance),
  }),
  getSettings: async () => mock.settings,
  updateSettings: (settings: any) => { mock.update(settings); mock.settings = settings; return Promise.resolve(); },
  on: async (event: string, callback: (value: any) => void) => {
    mock.listeners.set(event, callback);
    return () => mock.listeners.delete(event);
  },
}));
import { ProPresenter2Provider, ProPresenterScope, usePpConnection } from "./propresenterStore";

import { ClearDock } from "./components/ClearDock";

let root: Root;
let container: HTMLDivElement;
let second: ReturnType<typeof usePpConnection>;
function Probe() {
  const first = usePpConnection(1);
  second = usePpConnection(2);
  return <div>{JSON.stringify({ first: [first.connected, first.host, first.status], second: [second.connected, second.host, second.status] })}</div>;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.clear.mockReset().mockResolvedValue(null);
  vi.useFakeTimers(); mock.dial.mockReset().mockResolvedValue(null); mock.disconnect.mockReset().mockResolvedValue(null);
  mock.listeners.clear(); mock.update.mockClear();
  mock.settings = { pp_host: "first.local", pp_port: 1025, pp_auto_connect: true, pp2_host: "second.local", pp2_port: 1026, pp2_auto_connect: true };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const mount = () => act(async () => root.render(<ProPresenter2Provider><Probe /></ProPresenter2Provider>));

it("subscribes before autoconnect and isolates status and disconnects", async () => {
  mock.dial.mockImplementation(async () => {
    expect(mock.listeners.has("pp2:status")).toBe(true);
    mock.listeners.get("pp2:connected")?.({ host: "second.local", port: 1026 });
  });
  await mount();
  expect(mock.dial).toHaveBeenCalledWith(2, { host: "second.local", port: 1026 });
  await act(async () => mock.listeners.get("pp2:status")?.({ stream: "current_look", data: "second look" }));
  const data = JSON.parse(container.textContent!);
  expect(data.first).toEqual([true, "first.local:1025", { currentLook: "first look" }]);
  expect(data.second[2].currentLook).toBe("second look");
  await act(async () => second.disconnect());
  expect(mock.disconnect).toHaveBeenCalledWith(2);
  expect(mock.settings.pp_auto_connect).toBe(true);
  expect(mock.settings.pp2_auto_connect).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(18000));
  expect(mock.dial).toHaveBeenCalledTimes(1);
  expect(JSON.parse(container.textContent!).first[0]).toBe(true);
});

it("retries only the configured second host after a drop", async () => {
  await mount();
  await act(async () => mock.listeners.get("pp2:disconnected")?.(null));
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(mock.dial).toHaveBeenCalledTimes(2);
  expect(mock.dial.mock.calls.every(([instance, cfg]) => instance === 2 && cfg.host === "second.local")).toBe(true);
});

it("the clear toolbar uses the connection of its page", async () => {
  await act(async () => root.render(<ProPresenter2Provider><Probe /><ProPresenterScope instance={2}><ClearDock /></ProPresenterScope></ProPresenter2Provider>));
  await act(async () => mock.listeners.get("pp2:connected")?.({ host: "second.local", port: 1026 }));
  await act(async () => (container.querySelector('[title="Clear Slide"]') as HTMLButtonElement).click());
  expect(mock.clear).toHaveBeenCalledWith(2, "slide");
  expect(mock.clear).toHaveBeenCalledTimes(1);
});
