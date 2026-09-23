import { describe, expect, it } from "vitest";
import { confirmedMutes, muteConfidence, wavesState } from "../lib/deskConfidence";

const T0 = 1_700_000_000_000;
const snap = (over: Partial<Parameters<typeof muteConfidence>[0] & object> = {}) => ({
  mutes: { "input:39": true, "input:53": false, "input:7": true },
  muteSeen: { "input:39": T0 + 5_000, "input:53": T0 - 60_000 },
  connectedAt: T0,
  ...over,
});

describe("mute confidence", () => {
  it("confirmed only when the desk reported it since this connection", () => {
    const s = snap();
    expect(muteConfidence(s, "input:39")).toBe("confirmed"); // seen after connect
    expect(muteConfidence(s, "input:53")).toBe("remembered"); // seen before connect
    expect(muteConfidence(s, "input:7")).toBe("remembered"); // never stamped (old cache)
    expect(muteConfidence(s, "input:99")).toBe("unknown");
    expect(confirmedMutes(s)).toEqual({ "input:39": true });
  });
  it("an older booth with no stamps treats everything as remembered", () => {
    expect(muteConfidence({ mutes: { "input:1": true } } as any, "input:1")).toBe("remembered");
  });
  it("with no connection time (very old snapshot) a stamp is enough", () => {
    expect(muteConfidence({ mutes: { "input:1": true }, muteSeen: { "input:1": 5 } } as any, "input:1")).toBe("confirmed");
  });
});

describe("waves state from the last scene", () => {
  it("reads on/off from the configured scenes, unknown otherwise", () => {
    expect(wavesState(18, 18, 19)).toBe("on");
    expect(wavesState(19, 18, 19)).toBe("off");
    expect(wavesState(7, 18, 19)).toBe("unknown");
    expect(wavesState(null, 18, 19)).toBe("unknown");
    expect(wavesState(18, 0, 0)).toBe("unknown");
  });
});
