import { describe, expect, it } from "vitest";
import { isTuneOff, KEY_CHOICES, keyToPitchClass, keyToProgram, programName, TUNE_OFF_PROGRAM } from "../lib/keySend";

describe("song key → program", () => {
  it("keys map to pitch classes, minor and capo annotations ignored", () => {
    expect(keyToPitchClass("G")).toBe(7);
    expect(keyToPitchClass("Am")).toBe(9);
    expect(keyToPitchClass("Bb (Capo 1)")).toBe(10);
    expect(keyToPitchClass("C#m")).toBe(1);
    expect(keyToPitchClass("")).toBeNull();
  });
  it("tune off is the thirteenth program", () => {
    expect(isTuneOff("off")).toBe(true);
    expect(isTuneOff("Tune Off")).toBe(true);
    expect(isTuneOff("G")).toBe(false);
    expect(keyToProgram("off")).toBe(TUNE_OFF_PROGRAM);
    expect(keyToProgram("G")).toBe(7);
    expect(programName(12)).toBe("Tune off");
    expect(programName(7)).toBe("G");
  });
  it("the strip offers twelve keys then Tune off, in scene order", () => {
    expect(KEY_CHOICES).toHaveLength(13);
    expect(KEY_CHOICES[0]).toBe("C");
    expect(KEY_CHOICES[12]).toBe("off");
    expect(KEY_CHOICES.slice(0, 12).map((k) => keyToProgram(k))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
