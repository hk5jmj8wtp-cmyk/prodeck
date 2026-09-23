import { describe, expect, it } from "vitest";
import { askBody, FollowEngine, makeSlide, parsePick, tailOf, tokenize, type Action, type FSong } from "../lib/follow";

const gloria: FSong = {
  id: "gloria",
  name: "Angels We Have Heard On High",
  itemIdx: 1,
  bpm: 72,
  slides: [
    makeSlide(0, "Intro", ""),
    makeSlide(1, "Verse 1", "Angels we have heard on high\nSweetly singing o'er the plains"),
    makeSlide(2, "Verse 1", "And the mountains in reply\nEchoing their joyous strains"),
    makeSlide(3, "Chorus", "Gloria, in excelsis Deo\nGloria, in excelsis Deo"),
    makeSlide(4, "Verse 2", "Come to Bethlehem and see\nHim whose birth the angels sing"),
    makeSlide(5, "Verse 2", "Come adore on bended knee\nChrist the Lord, the newborn King"),
    makeSlide(6, "Chorus", "Gloria, in excelsis Deo\nGloria, in excelsis Deo"),
  ],
};
// Public-domain hymns only in fixtures.
const other: FSong = {
  id: "grace",
  name: "Amazing Grace",
  itemIdx: 3,
  bpm: 80,
  slides: [
    makeSlide(0, "Verse 1", "Amazing grace how sweet the sound\nThat saved a wretch like me"),
    makeSlide(1, "Verse 1", "I once was lost but now am found\nWas blind but now I see"),
  ],
};

const w = (text: string, end: number, extra: Partial<{ langP: number; logprob: number }> = {}) => ({ text, start: end - 4000, end, langP: 0.93, logprob: -0.1, ...extra });
const triggers = (a: Action[]) => a.filter((x) => x.type === "trigger") as Extract<Action, { type: "trigger" }>[];

describe("words", () => {
  it("normalises apostrophes, plurals and punctuation", () => {
    expect(tokenize("Sweetly singing o'er the plains!")).toEqual(["sweetly", "sing", "oer", "the", "plain"]);
    expect(tokenize("Echoing")).toEqual(tokenize("echo"));
    expect(tailOf("Angels we have heard on high\nSweetly singing o'er the plains")).toEqual(["sweetly", "sing", "oer", "the", "plain"]);
  });
});

describe("song lock", () => {
  it("locks onto the song being sung and lands on the right slide", () => {
    const e = new FollowEngine([gloria, other], {});
    const t = triggers([...e.onHeard(w("Angels we have heard on high", 10_000), 10_000)]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ slide: 1, via: "heard" });
    expect(t[0].song.id).toBe("gloria");
  });
  it("ignores what Whisper 'hears' in an instrumental", () => {
    const e = new FollowEngine([gloria, other], {});
    // The real hallucination from the test recording: prompt text, low English confidence.
    expect(triggers(e.onHeard(w("Christ the Lord, the newborn King", 10_000, { langP: 0.38, logprob: -0.41 }), 10_000))).toHaveLength(0);
    expect(e.view.hearing).toBe("music");
  });
  it("follows ProPresenter when a person picks the song", () => {
    const e = new FollowEngine([gloria, other], {}, { prompt: "current" });
    const a = e.onLive("grace", 0, 1000);
    expect(e.view.song).toBe("Amazing Grace");
    expect(a.find((x) => x.type === "prompt")).toMatchObject({ text: expect.stringMatching(/how sweet the sound/) });
  });
});

describe("on time", () => {
  it("moves when the current slide's last line has had time to finish — not when it starts, not when the next begins", () => {
    const e = new FollowEngine([gloria, other], {});
    e.onLive("gloria", 1, 0);
    expect(triggers(e.onHeard(w("Angels we have heard on high", 4000), 4000))).toHaveLength(0);
    // The last line is first heard in the window ending at 8 s. At 72 BPM a
    // line is two bars (6.7 s); it began ~1.5 s before that window ended.
    expect(triggers(e.onHeard(w("sweetly singing o'er the pain", 8000), 8000))).toHaveLength(0);
    expect(triggers(e.onTick(12_000))).toHaveLength(0);
    const t = triggers(e.onTick(12_500));
    expect(t[0]).toMatchObject({ slide: 2, reason: "heard the end of the slide" });
  });
  it("catches up when the next slide is already being sung", () => {
    const e = new FollowEngine([gloria, other], {});
    e.onLive("gloria", 1, 0);
    const t = triggers(e.onHeard(w("And the mountains in reply", 9000), 9000));
    expect(t[0]).toMatchObject({ slide: 2, reason: "heard the next slide" });
  });
  it("doesn't leave a slide whose last line repeats its first on the first line", () => {
    const e = new FollowEngine([gloria, other], {});
    e.onLive("gloria", 3, 0);
    expect(triggers(e.onHeard(w("Gloria in excelsis Deo", 2500), 2500))).toHaveLength(0);
    expect(triggers(e.onHeard(w("Gloria in excelsis Deo", 7000), 7000))).toHaveLength(0);
    // Two lines × 6.7 s: it ends at ~13.3 s.
    expect(triggers(e.onTick(12_000))).toHaveLength(0);
    expect(triggers(e.onTick(12_700))[0]).toMatchObject({ slide: 4 });
  });
  it("a repeated chorus resolves forward, never back to the first one", () => {
    const e = new FollowEngine([gloria, other], {});
    e.onLive("gloria", 5, 0);
    const t = triggers(e.onHeard(w("Gloria in excelsis Deo", 9000), 9000));
    expect(t[0]?.slide).toBe(6);
  });
  it("learns each slide's length from a person's advances and moves on time by the clock", () => {
    const e = new FollowEngine([gloria, other], {});
    // Two rehearsal passes: slide 2 lasts 8 s.
    for (const base of [10_000, 100_000]) {
      e.onLive("gloria", 1, base - 5000);
      e.onLive("gloria", 2, base);
      e.onLive("gloria", 3, base + 8000);
    }
    expect(e.dwell(gloria, 2)).toBe(8000);
    expect(e.timingDirty).toBe(true);
    // A slide joined halfway (a jump) teaches nothing.
    e.onLive("gloria", 5, 150_000);
    e.onLive("gloria", 6, 152_000);
    expect(e.dwell(gloria, 5)).toBeNull();
    // Sunday: slide 2 goes live, the singing is on it, and at 7.3 s the clock moves it.
    e.onLive("gloria", 1, 195_000);
    e.onLive("gloria", 2, 200_000);
    e.onHeard(w("And the mountains in reply", 203_000), 203_000);
    expect(triggers(e.onTick(207_000))).toHaveLength(0);
    const t = triggers(e.onTick(207_400));
    expect(t[0]).toMatchObject({ slide: 3, via: "clock" });
    // Never more than one slide on the clock alone.
    e.onLive("gloria", 3, 207_800);
  });
  it("rescales learned lengths when the tempo changes", () => {
    const e = new FollowEngine([{ ...gloria, bpm: 80 }], { gloria: { bpm: 72, slides: { "2": [8000, 8000] } } });
    expect(e.dwell({ ...gloria, bpm: 80 }, 2)).toBeCloseTo(7200);
  });
  it("prompts Whisper with the current slide only — never the lines still to come", () => {
    const e = new FollowEngine([gloria, other], {}, { prompt: "current" });
    const a = e.onLive("gloria", 4, 0);
    expect(a[0]).toMatchObject({ type: "prompt", text: "Come to Bethlehem and see Him whose birth the angels sing" });
    expect(new FollowEngine([gloria], {}).onLive("gloria", 4, 0)).toEqual([]);
  });
  it("won't move on a weak window or on filler words", () => {
    const e = new FollowEngine([gloria, other], {});
    e.onLive("gloria", 5, 0);
    // The instrumental hallucination from the replay, at high confidence.
    expect(triggers(e.onHeard(w("the Lord, the Lord, the Lord", 9000, { langP: 0.68, logprob: -0.11 }), 9000))).toHaveLength(0);
    // Real words, but Whisper unsure — confirms nothing, moves nothing.
    expect(triggers(e.onHeard(w("Gloria in excelsis Deo", 13_000, { langP: 0.33 }), 13_000))).toHaveLength(0);
    // Whisper's repetition loop is noise, however confident.
    expect(triggers(e.onHeard(w("The name of the Lord is the name of the Lord is the name of the Lord", 17_000, { langP: 0.63, logprob: -0.06 }), 17_000))).toHaveLength(0);
    expect(e.view.hearing).toBe("music");
  });
});

describe("the model", () => {
  it("builds a numbered lyric and parses the one-line answer", () => {
    const body = askBody({ type: "ask", song: gloria, current: 3, transcript: "", expect: 4 }, "gloria in excelsis");
    expect(body.messages[0].content).toMatch(/\[3\] \(Chorus\) Gloria/);
    expect(body.messages[0].content).toMatch(/Current slide: 3/);
    expect(parsePick({ content: [{ type: "text", text: 'Sure: {"slide": 6, "confidence": 0.8, "noise": false}' }] })).toEqual({ slide: 6, confidence: 0.8, noise: false });
    expect(parsePick({ content: [{ type: "text", text: "no idea" }] })).toBeNull();
  });
});
