import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AssistProviderFields } from "./AssistProviderFields";
import type { Settings } from "../lib/tauri";
let root: Root;
let container: HTMLDivElement;
const initial = { assist_provider: "anthropic", assist_api_key: "claude-test", gemini_api_key: "google-test", assist_model: "claude-opus-5", assist_gemini_model: "gemini-custom", assist_workspace_id: "workspace-test" } as Settings;
function Harness({ web = false, legacy = false }: { web?: boolean; legacy?: boolean }) {
  const [form, setForm] = useState({ ...initial, ...(web ? { gemini_api_key: null } : {}), ...(legacy ? { assist_provider: undefined } : {}) } as Settings);
  return <AssistProviderFields form={form} web={web} set={(key, value) => setForm((s) => ({ ...s, [key]: value }))} />;
}
const field = (label: string) => [...container.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input,select") as HTMLInputElement | HTMLSelectElement;
async function choose(provider: string) {
  await act(async () => { const select = field("AI provider"); select.value = provider; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("switches providers and retains each provider's key and model", async () => {
  await act(async () => root.render(<Harness />));
  expect(field("Anthropic API key (console.anthropic.com)").value).toBe("claude-test");
  await choose("gemini");
  expect(field("Gemini API key (Google AI Studio)").value).toBe("google-test");
  expect(field("Gemini model").value).toBe("gemini-custom");
  expect(field("Workspace ID (only for an account-level key)")).toBeUndefined();
  await choose("anthropic");
  expect(field("Anthropic API key (console.anthropic.com)").value).toBe("claude-test");
  expect(field("Model").value).toBe("claude-opus-5");
});
it("defaults old installations to Claude", async () => {
  await act(async () => root.render(<Harness legacy />));
  expect(field("AI provider").value).toBe("anthropic");
});
it("explains that Gemini keys are entered on the Mac when settings are opened in a browser", async () => {
  await act(async () => root.render(<Harness web />));
  await choose("gemini");
  const key = field("Gemini API key (Google AI Studio)") as HTMLInputElement;
  expect(key.disabled).toBe(true);
  expect(key.value).toBe("");
  expect(key.placeholder).toContain("Set on the ProDeck Mac");
});
