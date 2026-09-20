/**
 * "Is that mic actually live?"
 *
 * A vocal mic that fails is discovered by a congregation, not by a meter: the
 * singer opens their mouth and nothing happens. This watches the mics ProDeck
 * can see and says so first — once at a fixed point before the service, and
 * again if one drops out mid-worship.
 *
 * Where the signal comes from: the Avantis mirror carries mutes, faders and
 * scenes, but Allen & Heath's MIDI control protocol has no metering in it, so
 * the desk cannot answer this question. The audio does — each vocal mic is
 * routed to its own Dante channel, and `audio:channels` already reports a peak
 * per channel for all 64 of them.
 *
 * The detection here is easy. The restraint is the hard part: an alert that
 * fires on a singer pausing between verses gets ignored by the third Sunday,
 * and then it is worse than nothing. So this reports a mic only when it is
 * assigned to somebody on today's plan, open at the desk, and has been silent
 * for longer than anyone pauses.
 */

/** A mic ProDeck is watching, with everything known about it right now. */
export interface WatchedMic {
  /** ProDeck's mic number, as shown on the Planning Center page. */
  mic: string;
  /** 1-based channel on the audio input the booth captures. */
  channel: number;
  /** Who is on it on today's plan. Undefined means nobody — not watched. */
  person?: string;
  /** From the Avantis mirror. A muted mic is silent on purpose. */
  muted: boolean;
  /**
   * When this channel last carried signal, epoch ms. 0 means "not since
   * ProDeck started watching", which is the dead-all-morning case.
   */
  lastSoundMs: number;
}

export interface MicAlert {
  mic: string;
  channel: number;
  person?: string;
  /** How long it has been quiet. Infinity when it has never made a sound. */
  silentForMs: number;
  /** `never` reads differently from `dropped` and deserves different words. */
  reason: "never" | "dropped";
}

export interface MicCheckOptions {
  /**
   * Peak below this counts as no signal. −50 dBFS is comfortably beneath a
   * live vocal mic's room noise and comfortably above a muted channel's
   * digital silence, which is what makes this a reliable line rather than a
   * guess — an unrouted Dante channel reads exactly 0.
   */
  thresholdDb?: number;
  /** How long a mic must be quiet mid-worship before it counts. */
  liveGraceMs?: number;
  /**
   * For the pre-service check: how far back to look for any sign of life. A
   * mic used during soundcheck passes; one that has been quiet this long has
   * not been working, rather than merely not being sung into.
   */
  precheckLookbackMs?: number;
}

const DEFAULTS = {
  thresholdDb: -50,
  liveGraceMs: 30_000,
  precheckLookbackMs: 10 * 60_000,
} satisfies Required<MicCheckOptions>;

/** How long before the service start the pre-service check fires. */
export const PRECHECK_LEAD_MS = 90_000;

/** Linear peak (0..1, as `audio:channels` reports) to dBFS. */
export function peakDb(peak: number): number {
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function hasSignal(peak: number, thresholdDb = DEFAULTS.thresholdDb): boolean {
  return peakDb(peak) > thresholdDb;
}

export type MicPhase = "idle" | "precheck" | "worship";

/**
 * Which phase the mic watch is in.
 *
 * `precheck` is a single window ending at the service start — the operator
 * asked for a minute and a half, which is enough time to walk to the stage and
 * swap a battery, and short enough that the stage is already populated.
 * `worship` is any moment a song is the live item.
 */
export function micPhase(
  serviceStartTs: number | null,
  songLive: boolean,
  now: number,
  leadMs = PRECHECK_LEAD_MS,
): MicPhase {
  if (songLive) return "worship";
  if (serviceStartTs !== null && now >= serviceStartTs - leadMs && now < serviceStartTs) {
    return "precheck";
  }
  return "idle";
}

/**
 * The mics worth shouting about, worst first.
 *
 * Silent on its own is never enough. A mic is reported only when all of these
 * hold, and each one exists because without it the alert would be wrong rather
 * than merely noisy:
 *
 * - somebody is on it on today's plan — an unassigned mic is spare, not broken
 * - it is open at the desk — a muted channel is silent because someone muted it
 * - it has been quiet longer than a person pauses
 */
export function micAlerts(
  mics: WatchedMic[],
  phase: MicPhase,
  now: number,
  opts: MicCheckOptions = {},
): MicAlert[] {
  if (phase === "idle") return [];
  const { liveGraceMs, precheckLookbackMs } = { ...DEFAULTS, ...opts };
  const quietFor = phase === "worship" ? liveGraceMs : precheckLookbackMs;

  return mics
    .filter((m) => m.person && !m.muted)
    .map((m) => {
      const silentForMs = m.lastSoundMs > 0 ? now - m.lastSoundMs : Infinity;
      return {
        mic: m.mic,
        channel: m.channel,
        person: m.person,
        silentForMs,
        reason: (m.lastSoundMs > 0 ? "dropped" : "never") as MicAlert["reason"],
      };
    })
    .filter((a) => a.silentForMs > quietFor)
    .sort((a, b) => b.silentForMs - a.silentForMs);
}

/** One line for the booth, e.g. "Mic 3 (Denise Dumas) — no signal all morning". */
export function describeAlert(a: MicAlert): string {
  const who = a.person ? ` (${a.person})` : "";
  if (a.reason === "never") return `Mic ${a.mic}${who} — no signal all morning`;
  const mins = Math.floor(a.silentForMs / 60_000);
  const secs = Math.round(a.silentForMs / 1000);
  const ago = mins >= 1 ? `${mins} min` : `${secs}s`;
  return `Mic ${a.mic}${who} — silent for ${ago}`;
}
