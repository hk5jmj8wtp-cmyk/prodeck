import type { Settings } from "../lib/tauri";

export function AssistProviderFields({ form, set, web }: {
  form: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  web: boolean;
}) {
  const gemini = form.assist_provider === "gemini";
  return <>
    <label className="field">
      <span>AI provider</span>
      <select className="input" value={form.assist_provider || "anthropic"}
        onChange={(e) => set("assist_provider", e.target.value === "gemini" ? "gemini" : "anthropic")}>
        <option value="anthropic">Claude (Anthropic)</option>
        <option value="gemini">Gemini (Google)</option>
      </select>
    </label>
    {gemini ? <>
      <label className="field wide">
        <span>Gemini API key (Google AI Studio)</span>
        <input className="input" type="password" autoComplete="off" disabled={web}
          placeholder={web ? "Set on the ProDeck Mac — hidden from browsers" : "Paste your Gemini API key"}
          value={form.gemini_api_key ?? ""} onChange={(e) => set("gemini_api_key", e.target.value || null)} />
      </label>
      <label className="field">
        <span>Gemini model</span>
        <input className="input" list="assist-gemini-models" placeholder="gemini-3.8-flash"
          value={form.assist_gemini_model || ""} onChange={(e) => set("assist_gemini_model", e.target.value.trim())} />
        <datalist id="assist-gemini-models">
          <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
          <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option>
        </datalist>
        <span className="hint">Blank uses Gemini 3.8 Flash. You can enter another model ID available to your API key.</span>
      </label>
    </> : <>
      <label className="field wide">
        <span>Anthropic API key (console.anthropic.com)</span>
        <input className="input" type="password" autoComplete="off"
          placeholder="sk-ant-… — stored only on this machine"
          value={form.assist_api_key ?? ""} onChange={(e) => set("assist_api_key", e.target.value || null)} />
      </label>
      <label className="field">
        <span>Workspace ID (only for an account-level key)</span>
        <input className="input" autoComplete="off" placeholder="wrkspc_… — console.anthropic.com → Settings → Workspaces"
          value={form.assist_workspace_id ?? ""} onChange={(e) => set("assist_workspace_id", e.target.value.trim())} />
      </label>
      <label className="field">
        <span>Model</span>
        <select className="input" value={form.assist_model || "claude-sonnet-5"} onChange={(e) => set("assist_model", e.target.value)}>
          <option value="claude-sonnet-5">Claude Sonnet 5 — fast, recommended</option>
          <option value="claude-opus-5">Claude Opus 5 — deeper, slower</option>
          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 — cheapest</option>
        </select>
      </label>
    </>}
  </>;
}
