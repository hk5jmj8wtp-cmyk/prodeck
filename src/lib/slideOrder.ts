/**
 * Putting a presentation's slides in the order ProPresenter is actually
 * playing them.
 *
 * ProPresenter keeps a song twice over. The LIBRARY order is the groups as
 * stored — Intro, Verse 1, Verse 2, Chorus, each appearing once. The
 * ARRANGEMENT is the performance order, which repeats groups and skips
 * others. Every cue index ProPresenter reports or accepts — `slide_index`,
 * the playlist trigger, the thumbnail endpoint — counts in arrangement space.
 *
 * Get this wrong and the numbers still look plausible, which is why it went
 * unnoticed. A real song off this booth: 14 groups / 69 slides in library
 * order, and an arrangement of 21 group references expanding to 117 cues. The
 * live slide reported as index 9 is a different slide in each ordering, and
 * anything past 68 does not exist in library order at all — so the grid
 * highlighted the wrong slide early in a song and nothing whatsoever after it.
 */

export interface Slide {
  /** Position in the ordering below — the cue index ProPresenter speaks. */
  index: number;
  group: string;
  color?: string;
  text: string;
}

function groupColor(c: any): string | undefined {
  if (!c) return undefined;
  if (typeof c === "string") return c;
  const { red, green, blue } = c;
  if ([red, green, blue].some((v) => typeof v !== "number")) return undefined;
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to(red)}, ${to(green)}, ${to(blue)})`;
}

function flatten(sequence: any[]): Slide[] {
  const out: Slide[] = [];
  let idx = 0;
  for (const g of sequence) {
    const group = (g?.name ?? "").toString();
    const color = groupColor(g?.color);
    const slides = Array.isArray(g?.slides) ? g.slides : [];
    for (const s of slides) {
      const text = (s?.text ?? "").toString().replace(/\s+/g, " ").trim();
      out.push({ index: idx, group, color, text });
      idx += 1;
    }
  }
  return out;
}

/** The group objects an arrangement refers to, in its own order. */
function sequenceFor(pres: any, arrangementUuid: string | undefined): any[] | null {
  if (!arrangementUuid) return null;
  const groups: any[] = Array.isArray(pres?.groups) ? pres.groups : [];
  const byUuid = new Map<string, any>();
  // Groups carry a BARE `uuid`; arrangements refer to them by that string.
  // (The arrangement's own id is nested under `id.uuid` — different shape,
  // same document.)
  for (const g of groups) if (g?.uuid) byUuid.set(g.uuid, g);
  const arrangements: any[] = Array.isArray(pres?.arrangements) ? pres.arrangements : [];
  const arr = arrangements.find((a: any) => a?.id?.uuid === arrangementUuid);
  const refs: any[] = Array.isArray(arr?.groups) ? arr.groups : [];
  if (!refs.length) return null;
  const mapped = refs
    .map((gu: any) => byUuid.get(typeof gu === "string" ? gu : gu?.uuid))
    .filter(Boolean);
  return mapped.length ? mapped : null;
}

/**
 * Slides for a presentation whose arrangement is known — a playlist item
 * carries one on `presentation_info.arrangement_uuid`.
 */
export function parseSlides(j: any, arrangementUuid?: string): Slide[] {
  const pres = j?.presentation ?? j ?? {};
  return flatten(sequenceFor(pres, arrangementUuid) ?? (Array.isArray(pres.groups) ? pres.groups : []));
}

/**
 * Slides for the presentation that is LIVE, where no playlist item is telling
 * us which arrangement is in play.
 *
 * `current_arrangement` would be the obvious answer and often is, but on this
 * booth it comes back as an empty string while the arrangement is plainly in
 * use — ProPresenter reports 117 cues for a 69-slide library order. So rather
 * than guess, ask: `total_cues` says how many cues ProPresenter counts, and
 * the correct ordering is the one that produces exactly that many. That is a
 * fact about the running document rather than an assumption about which field
 * is populated, and it degrades sensibly — with no `total_cues` to check
 * against, it falls back to `current_arrangement`, then to library order.
 */
export function slidesForActivePresentation(j: any, totalCues?: number | null): Slide[] {
  const pres = j?.presentation ?? j ?? {};
  const groups: any[] = Array.isArray(pres.groups) ? pres.groups : [];
  const arrangements: any[] = Array.isArray(pres.arrangements) ? pres.arrangements : [];
  const current: string = (pres.current_arrangement ?? "").toString();

  // What to use when there is nothing to check against. Never a guessed
  // arrangement: an arrangement ProPresenter is not playing yields indices
  // that are confidently wrong for the whole song, which is worse than
  // stored order being plainly out of step.
  const fallback = (current && sequenceFor(pres, current)) || groups;

  if (typeof totalCues === "number" && totalCues > 0) {
    // Whatever ProPresenter names as current is tried first, so two
    // arrangements of equal length resolve to the one it actually selected.
    const candidates: any[][] = [];
    if (current) {
      const seq = sequenceFor(pres, current);
      if (seq) candidates.push(seq);
    }
    for (const a of arrangements) {
      const uuid = a?.id?.uuid;
      if (!uuid || uuid === current) continue;
      const seq = sequenceFor(pres, uuid);
      if (seq) candidates.push(seq);
    }
    candidates.push(groups);
    const count = (seq: any[]) =>
      seq.reduce((n, g) => n + (Array.isArray(g?.slides) ? g.slides.length : 0), 0);
    const match = candidates.find((seq) => count(seq) === totalCues);
    if (match) return flatten(match);
  }
  return flatten(fallback);
}

/** `total_cues` off a presentation payload, when ProPresenter includes it. */
export function totalCues(j: any): number | null {
  const n = (j?.presentation ?? j ?? {})?.total_cues;
  return typeof n === "number" ? n : null;
}
