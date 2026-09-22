import { describe, expect, it } from "vitest";
import song from "./fixtures/pp-song.json";
import { parseSlides, slidesForActivePresentation, totalCues } from "../lib/slideOrder";

/**
 * Captured live from a ProPresenter running this booth's Sunday set — the song
 * from the bug report, with slide text stripped and nothing else touched. The
 * numbers below are ProPresenter's own, not invented for the test.
 */
const ARRANGEMENT_UUID = "346469B9-3EEC-4260-A80D-29B1FA66D4AF";

describe("the two orderings a ProPresenter song has", () => {
  it("library order is not what ProPresenter is playing", () => {
    const lib = parseSlides(song);
    expect(lib).toHaveLength(69);
    expect(totalCues(song)).toBe(117);
    // The gap is the whole bug: 48 cues that library order cannot address.
    expect(lib.length).toBeLessThan(totalCues(song)!);
  });

  it("the arrangement expands to exactly the cue count ProPresenter reports", () => {
    expect(parseSlides(song, ARRANGEMENT_UUID)).toHaveLength(117);
  });

  it("repeats a group that the arrangement repeats", () => {
    const arr = parseSlides(song, ARRANGEMENT_UUID);
    const lib = parseSlides(song);
    const chorus = (s: { group: string }[]) => s.filter((x) => x.group === "Chorus").length;
    expect(chorus(arr)).toBeGreaterThan(chorus(lib));
  });
});

describe("slidesForActivePresentation", () => {
  it("picks the ordering matching total_cues, even with current_arrangement empty", () => {
    // Exactly the live state: ProPresenter reports 117 cues and leaves
    // current_arrangement as "". Guessing from that field alone would have
    // fallen back to library order and been wrong for the whole song.
    expect((song as any).presentation.current_arrangement).toBe("");
    expect(slidesForActivePresentation(song, 117)).toHaveLength(117);
  });

  it("the live cue index addresses a real slide, which library order could not", () => {
    const slides = slidesForActivePresentation(song, 117);
    // ProPresenter reported index 9 live; and a late cue that simply does not
    // exist in the 69-slide library ordering.
    expect(slides[9]).toBeDefined();
    expect(slides[110]).toBeDefined();
    expect(parseSlides(song)[110]).toBeUndefined();
  });

  it("falls back to library order when that is what matches", () => {
    // A presentation played in stored order reports its library count.
    expect(slidesForActivePresentation(song, 69)).toHaveLength(69);
  });

  it("does not invent an ordering when total_cues is unknown", () => {
    // No cue count and no current_arrangement: library order, as before.
    expect(slidesForActivePresentation(song, null)).toHaveLength(69);
  });

  it("indices are contiguous from zero in whichever ordering wins", () => {
    const s = slidesForActivePresentation(song, 117);
    expect(s.map((x) => x.index)).toEqual(s.map((_, i) => i));
  });
});
