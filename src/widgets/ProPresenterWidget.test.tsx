import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Widget } from "../lib/dashboards";
const mock = vi.hoisted(() => ({
  connections: {} as Record<number, any>, settings: {} as any,
  action: vi.fn(), timer: vi.fn(), send: vi.fn(), clear: vi.fn(), save: vi.fn(),
}));
vi.mock("../store", () => ({ useProDeck: () => ({ ...mock.connections[1], settings: mock.settings }) }));
vi.mock("../lib/perms", () => ({ usePerms: () => ({ can: () => true }) }));
vi.mock("../lib/tauri", async (original) => ({
  ...await original<typeof import("../lib/tauri")>(),
  getSettings: async () => mock.settings,
  updateSettings: async (s: any) => { mock.save(s); mock.settings = s; },
  createPpClient: (instance: number) => ({
    ppGet: async (path: string) => {
      if (path === "timers") return [{ id: { uuid: "same-timer" }, ...(instance === 2 ? { elapsed: {} } : { countdown: {} }) }];
      if (path === "playlists") return [{ field_type: "playlist", id: { uuid: "same-playlist", name: `Machine ${instance}` } }];
      if (path.startsWith("playlist/")) return { items: [{ id: { name: `Loop ${instance}` }, type: "presentation", destination: "announcements" }] };
      if (path === "announcement/active") return { announcement: { id: { name: `Loop ${instance}` } } };
      return { presentation: { groups: [{ name: "Verse", slides: [{ text: `Machine ${instance} slide` }] }] } };
    },
    ppTriggerActiveCue: (cue: number) => mock.action(instance, cue),
    ppAction: (path: string) => mock.action(instance, path),
    ppTimerOp: (id: string, op: string) => mock.timer(instance, id, op),
    ppSetStageMessage: (text: string) => mock.send(instance, text),
    ppClearStageMessage: () => mock.clear(instance),
    ppClearLayer: (layer: string) => mock.clear(instance, layer),
  }),
}));
vi.mock("../propresenterStore", async (original) => {
  const actual = await original<typeof import("../propresenterStore")>();
  return { ...actual, usePpConnection: (override?: number) => {
    const scope = actual.usePpInstance();
    return mock.connections[override ?? scope];
  } };
});
import { WIDGET_MAP } from "./registry";
import { widgetPpInstance, widgetTitle, dashboardPpInstances } from "../lib/ppWidgets";
let root: Root;
let container: HTMLDivElement;
const widget = (type: string, instance?: number, extra = {}): Widget => ({ id: `${type}-${instance}`, type, x: 0, y: 0, w: 4, h: 4, config: { ...(instance ? { ppInstance: instance } : {}), ...extra } });
const renderWidget = (w: Widget, editing = false, update = vi.fn()) => {
  const Comp = WIDGET_MAP[w.type].component;
  return <section data-instance={w.config.ppInstance ?? 1}><Comp widget={w} editing={editing} update={update} /></section>;
};
const button = (instance: number, text: string) => [...container.querySelectorAll<HTMLButtonElement>(`[data-instance="${instance}"] button`)].find((b) => b.textContent?.trim() === text)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  for (const fn of [mock.action, mock.timer, mock.send, mock.clear, mock.save]) fn.mockReset().mockResolvedValue(undefined);
  mock.settings = { pp_auto_connect: true, pp2_auto_connect: false, lobby_auto_playlist: "first-loop", lobby_auto_index: 4, lobby_auto_name: "First loop" };
  for (const n of [1, 2]) mock.connections[n] = { connected: true, host: `machine${n}:1025`, label: n === 2 ? "propresenter 2" : "ProPresenter", status: {
    activePresentation: { presentation: { id: { uuid: "same-slide", name: `Machine ${n}` } } },
    slideIndex: { presentation_index: { index: 0, total_cues: 1 } },
    currentTimers: [{ id: { uuid: "same-timer", name: `Timer ${n}` }, state: "running", time: "00:10" }],
    stageMessage: { message: `Message ${n}` },
  } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

it("shows independent live slides and directs clicks to the tile's source", async () => {
  await act(async () => root.render(<>{renderWidget(widget("slide_grid", 1))}{renderWidget(widget("slide_grid", 2))}</>));
  expect(container.textContent).toContain("Machine 1 slide");
  expect(container.textContent).toContain("Machine 2 slide");
  await act(async () => button(2, "1Machine 2 slide").click());
  expect(mock.action.mock.calls).toEqual([[2, 0]]);
});
it("keeps identical timer IDs with opposite directions independent", async () => {
  await act(async () => root.render(<>{renderWidget(widget("timer", 1, { timerId: "same-timer" }))}{renderWidget(widget("timer", 2, { timerId: "same-timer" }))}</>));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.querySelector('[data-instance="1"]')?.textContent).toContain("00:09");
  expect(container.querySelector('[data-instance="2"]')?.textContent).toContain("00:11");
  await act(async () => button(2, "Start").click());
  expect(mock.timer.mock.calls).toEqual([[2, "same-timer", "start"]]);
});
it("stage message buttons and timed clears stay on machine two", async () => {
  await act(async () => root.render(<>{renderWidget(widget("stage_message", 1))}{renderWidget(widget("stage_message", 2, { presets: ["Second alert"], autoClearSec: 1 }))}</>));
  await act(async () => button(2, "Second alert").click());
  expect(mock.send.mock.calls).toEqual([[2, "Second alert"]]);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(mock.clear.mock.calls).toEqual([[2]]);
});
it("changing source resets machine-specific choices and remounts live content", async () => {
  const update = vi.fn();
  await act(async () => root.render(renderWidget(widget("timer", 1, { timerId: "same-timer" }), true, update)));
  const select = container.querySelector<HTMLSelectElement>(".pp-widget-source select")!;
  await act(async () => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(update).toHaveBeenCalledWith({ ppInstance: 2, timerId: null, screenIndex: null });
  await act(async () => root.render(renderWidget(widget("timer", 2), true)));
  expect(container.textContent).toContain("Timer 2");
  expect(container.textContent).not.toContain("Timer 1");
});
it("saves and clears lobby auto-restore only for the selected machine", async () => {
  await act(async () => root.render(renderWidget(widget("lobby_tv", 2))));
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => { select.value = "same-playlist:0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mock.settings.lobby_auto_playlist).toBe("first-loop");
  expect(mock.settings.pp2_lobby_auto_playlist).toBe("same-playlist");
  await act(async () => button(2, "▶ Loop 2").click());
  expect(mock.action).toHaveBeenCalledWith(2, "playlist/same-playlist/0/trigger");
  await act(async () => button(2, "✕ Clear lobby TVs").click());
  expect(mock.settings.lobby_auto_playlist).toBe("first-loop");
  expect(mock.settings.pp2_lobby_auto_playlist).toBe("");
  expect(mock.clear).toHaveBeenCalledWith(2, "announcements");
});
it("shows the second machine's offline state while first-machine widgets stay live", async () => {
  mock.connections[2].connected = false;
  await act(async () => root.render(<>{renderWidget(widget("slide_grid", 1))}{renderWidget(widget("slide_grid", 2))}</>));
  expect(container.textContent).toContain("Machine 1 slide");
  expect(container.textContent).toContain("Set up propresenter 2");
});
it("old layouts remain primary and saved mixed-source layouts keep their labels", () => {
  const old = widget("slide_preview");
  const second = JSON.parse(JSON.stringify(widget("slide_preview", 2)));
  expect(widgetPpInstance(old)).toBe(1);
  expect(widgetPpInstance(second)).toBe(2);
  expect(widgetTitle("Slide Preview", second)).toBe("Slide Preview · propresenter 2");
  expect(dashboardPpInstances([old, second, widget("clock", 2)])).toEqual([1, 2]);
});
