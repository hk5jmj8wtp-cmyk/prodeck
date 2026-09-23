// How much to trust what the mirror says about the desk.
//
// The Avantis protocol has no "get mute" (probed 2026-09-23: it ignores the
// dLive-style query). ProDeck learns a mute only when the desk changes it, and
// remembers it across restarts. So a mute can be REMEMBERED (from before this
// connection) or CONFIRMED (the desk said so since it connected). A remembered
// mute is a good guess and a bad fact: it is what showed "muted" on ProDeck
// while the desk was open. Everything that acts on mutes uses this.

import type { AvantisSnapshot } from "./tauri";

export type MuteConfidence = "confirmed" | "remembered" | "unknown";

export function muteConfidence(snap: Pick<AvantisSnapshot, "mutes" | "muteSeen" | "connectedAt"> | null | undefined, id: string): MuteConfidence {
  if (!snap || snap.mutes[id] === undefined) return "unknown";
  const seen = snap.muteSeen?.[id];
  const since = snap.connectedAt ?? undefined;
  if (typeof seen === "number" && (since === undefined || seen >= since)) return "confirmed";
  return "remembered";
}

/** Only mutes the desk has confirmed this connection. */
export function confirmedMutes(snap: Pick<AvantisSnapshot, "mutes" | "muteSeen" | "connectedAt"> | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!snap) return out;
  for (const [k, v] of Object.entries(snap.mutes)) if (muteConfidence(snap, k) === "confirmed") out[k] = v;
  return out;
}

export type WavesState = "on" | "off" | "unknown";

/** Which way the outboard rig was last switched, from the last scene recall. */
export function wavesState(scene: number | null | undefined, onScene: number, offScene: number): WavesState {
  if (!scene || (!onScene && !offScene)) return "unknown";
  if (onScene && scene === onScene) return "on";
  if (offScene && scene === offScene) return "off";
  return "unknown";
}

export function fmtSince(ms: number | null | undefined, now: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}
