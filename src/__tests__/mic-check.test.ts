import { describe, expect, it } from "vitest";
import {
  PRECHECK_LEAD_MS,
  describeAlert,
  hasSignal,
  micAlerts,
  micPhase,
  peakDb,
  type WatchedMic,
} from "../lib/micCheck";

const NOW = Date.parse("September 20, 2026 10:58:30");
const SERVICE = Date.parse("September 20, 2026 11:00:00");

const mic = (over: Partial<WatchedMic> = {}): WatchedMic => ({
  mic: "3",
  channel: 7,
  person: "Denise Dumas",
  muted: false,
  lastSoundMs: NOW - 1000,
  ...over,
});

describe("signal threshold", () => {
  it("separates a live mic from an unrouted channel", () => {
    // These are real numbers off the booth: an unrouted Dante channel reads
    // exactly 0, and a live vocal mic in a quiet room read −33 dBFS.
    expect(peakDb(0)).toBe(-Infinity);
    expect(hasSignal(0)).toBe(false);
    expect(hasSignal(0.0224)).toBe(true); // ≈ −33 dBFS
  });

  it("treats a channel far below room noise as dead", () => {
    expect(hasSignal(0.001)).toBe(false); // −60 dBFS
  });
});

describe("micPhase", () => {
  it("opens the pre-service check 90 seconds before the service", () => {
    expect(PRECHECK_LEAD_MS).toBe(90_000);
    expect(micPhase(SERVICE, false, SERVICE - 91_000)).toBe("idle");
    expect(micPhase(SERVICE, false, SERVICE - 90_000)).toBe("precheck");
    expect(micPhase(SERVICE, false, SERVICE - 1_000)).toBe("precheck");
  });

  it("closes it once the service has started", () => {
    expect(micPhase(SERVICE, false, SERVICE)).toBe("idle");
    expect(micPhase(SERVICE, false, SERVICE + 60_000)).toBe("idle");
  });

  it("watches whenever a song is live, whatever the clock says", () => {
    expect(micPhase(SERVICE, true, SERVICE + 20 * 60_000)).toBe("worship");
    // Even before the pre-check window — a rehearsal song still counts.
    expect(micPhase(SERVICE, true, SERVICE - 40 * 60_000)).toBe("worship");
  });

  it("stays idle when there is no service time to count from", () => {
    expect(micPhase(null, false, NOW)).toBe("idle");
  });
});

describe("micAlerts", () => {
  it("says nothing while idle, however dead the mic is", () => {
    expect(micAlerts([mic({ lastSoundMs: 0 })], "idle", NOW)).toEqual([]);
  });

  it("flags a mic that has had no signal all morning", () => {
    const [a] = micAlerts([mic({ lastSoundMs: 0 })], "precheck", NOW);
    expect(a.reason).toBe("never");
    expect(describeAlert(a)).toBe("Mic 3 (Denise Dumas) — no signal all morning");
  });

  it("passes a mic that was used at soundcheck", () => {
    expect(micAlerts([mic({ lastSoundMs: NOW - 4 * 60_000 })], "precheck", NOW)).toEqual([]);
  });

  /**
   * The rule that decides whether anyone still trusts this by December. A
   * singer rests between verses; the alert must not.
   */
  it("does not fire on a singer pausing between verses", () => {
    expect(micAlerts([mic({ lastSoundMs: NOW - 12_000 })], "worship", NOW)).toEqual([]);
    expect(micAlerts([mic({ lastSoundMs: NOW - 29_000 })], "worship", NOW)).toEqual([]);
  });

  it("fires when a live mic really has dropped out", () => {
    const [a] = micAlerts([mic({ lastSoundMs: NOW - 45_000 })], "worship", NOW);
    expect(a.reason).toBe("dropped");
    expect(describeAlert(a)).toBe("Mic 3 (Denise Dumas) — silent for 45s");
  });

  it("ignores a mic that is muted at the desk", () => {
    // Muted is a decision someone made, not a fault. ProDeck knows, because
    // the Avantis mirror carries mute state.
    expect(micAlerts([mic({ muted: true, lastSoundMs: 0 })], "precheck", NOW)).toEqual([]);
  });

  it("ignores a spare mic nobody is on this week", () => {
    expect(micAlerts([mic({ person: undefined, lastSoundMs: 0 })], "precheck", NOW)).toEqual([]);
  });

  it("puts the worst offender first", () => {
    const out = micAlerts(
      [
        mic({ mic: "1", channel: 5, person: "Amber", lastSoundMs: NOW - 45_000 }),
        mic({ mic: "2", channel: 6, person: "Allan", lastSoundMs: 0 }),
        mic({ mic: "4", channel: 8, person: "Emily", lastSoundMs: NOW - 90_000 }),
      ],
      "worship",
      NOW,
    );
    expect(out.map((a) => a.mic)).toEqual(["2", "4", "1"]);
  });

  it("renders minutes once seconds stop being useful", () => {
    const [a] = micAlerts([mic({ lastSoundMs: NOW - 3 * 60_000 })], "worship", NOW);
    expect(describeAlert(a)).toBe("Mic 3 (Denise Dumas) — silent for 3 min");
  });
});
