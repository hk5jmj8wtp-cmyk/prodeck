import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  return { invoke: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./demo", () => ({ IS_DEMO: false }));
import { createPpClient, ppNext } from "./tauri";

beforeEach(() => { invoke.mockReset().mockResolvedValue(null); });

describe("independent ProPresenter clients", () => {
  it("keeps every second-machine operation explicitly targeted", async () => {
    const c = createPpClient(2);
    await c.ppConnect({ host: "second.local", port: 1025 });
    await c.ppGet("looks");
    await c.ppPut("stage/message", "hello");
    await c.ppDelete("stage/message");
    await c.ppNext(); await c.ppPrevious();
    await c.ppTriggerLook("look"); await c.ppTriggerMacro("macro");
    await c.ppTriggerMessage("message"); await c.ppTimerOp("timer", "start");
    await c.ppSetStageMessage("hello"); await c.ppClearStageMessage();
    await c.ppClearLayer("slide"); await c.ppAction("prop/id/trigger");
    await c.ppThumbnail("shared-id", 0);
    await c.ppPlaylistThumbnail("shared-id", 0, 1);
    await c.ppTriggerActiveCue(1); await c.ppFocusTrigger("id", 2);
    await c.ppPlaylistTrigger("pl", 0, 1);
    await c.ppIsConnected(); await c.ppDisconnect();
    expect(invoke.mock.calls.length).toBeGreaterThan(20);
    expect(invoke.mock.calls.every(([, args]) => args.instance === 2)).toBe(true);
    await ppNext();
    expect(invoke).toHaveBeenLastCalledWith("pp_trigger_next", {});
  });

  it("keeps playlist fallbacks on machine two while primary controls run", async () => {
    let rejectFirst!: (e: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const trigger = createPpClient(2).ppPlaylistTrigger("same-id", 3, 7);
    await ppNext();
    rejectFirst(new Error("unsupported cue trigger"));
    await trigger;
    expect(invoke.mock.calls).toEqual([
      ["pp_action", { path: "playlist/same-id/3/7/trigger", instance: 2 }],
      ["pp_trigger_next", {}],
      ["pp_action", { path: "playlist/same-id/3/trigger", instance: 2 }],
    ]);
  });

  it("identifies the failed machine to the operator", async () => {
    const handler = vi.fn();
    window.addEventListener("prodeck-control-error", handler);
    invoke.mockRejectedValueOnce(new Error("offline"));
    await createPpClient(2).ppNext();
    expect(handler.mock.calls[0][0].detail).toContain("propresenter 2");
    window.removeEventListener("prodeck-control-error", handler);
  });
});
