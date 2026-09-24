import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { fetchThumb } = vi.hoisted(() => ({ fetchThumb: vi.fn(async (instance: number) => `data:image/png;base64,machine${instance}`) }));
vi.mock("../lib/tauri", () => ({
  createPpClient: (instance: number) => ({
    ppThumbnail: () => fetchThumb(instance), ppPlaylistThumbnail: () => fetchThumb(instance),
  }),
}));
vi.mock("../store", () => ({ useProDeck: vi.fn() }));
import { ProPresenterScope } from "../propresenterStore";
import { SlideThumb } from "./SlideThumb";

it("does not reuse machine one's cached thumbnail on machine two for the same slide ID", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private cb: (entries: any[]) => void) {}
    observe() { this.cb([{ isIntersecting: true }]); }
    disconnect() {}
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProPresenterScope instance={1}><SlideThumb uuid="shared-id" index={0} /></ProPresenterScope>));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("machine1");
    await act(async () => root.render(<ProPresenterScope instance={2}><SlideThumb uuid="shared-id" index={0} /></ProPresenterScope>));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("machine2");
    expect(fetchThumb.mock.calls).toEqual([[1], [2]]);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
