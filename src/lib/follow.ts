// Auto-Follow v2 — the decision engine (design/AUTOFOLLOW.md).
//
// Pure and clock-injected so it can be tested on recorded transcripts. The
// provider (lyricFollow.tsx) feeds it three streams and carries out what it
// returns:
//   onHeard  — every Whisper window (4 s, every 2 s) with its wall-clock span
//   onLive   — ProPresenter's current slide (whoever moved it)
//   onTick   — a heartbeat, so the clock can move a slide on time
// and it answers with Actions: trigger a slide, ask the model, or set the
// Whisper prompt.
//
// The rule Zach set: a slide two seconds late is a sin, one second early is
// forgivable. So the engine advances on the END of the current slide (its
// last line being sung), not on the start of the next, and the learned clock
// moves it at the moment it usually ends when the singing agrees.

export interface FSlide {
  index: number; // position in the playlist item's arrangement = trigger index
  section: string;
  text: string;
  tokens: string[];
  /** Tokens of the slide's last line — hearing these means it is ending. */
  tail: string[];
}
export interface FSong {
  id: string; // presentation uuid
  name: string;
  itemIdx: number; // raw playlist position (trigger path)
  slides: FSlide[];
  bpm?: number;
}
export interface Heard {
  text: string;
  start: number;
  end: number;
  quiet?: boolean;
  langP?: number | null;
  logprob?: number | null;
}
export type Via = "heard" | "clock" | "model" | "pro";
export type Action =
  | { type: "trigger"; song: FSong; slide: number; via: Via; reason: string }
  | { type: "ask"; song: FSong; current: number; transcript: string; expect: number | null }
  | { type: "prompt"; text: string };

/** Per song: the BPM it was learned at and recent dwell times per slide. */
export type Timing = Record<string, { bpm?: number; slides: Record<string, number[]> }>;

export interface FollowView {
  song: string | null;
  songId: string | null;
  bpm: number | null;
  slide: number | null;
  section: string;
  /** When the clock expects the next slide (ms epoch), if it knows. */
  dueAt: number | null;
  slideStartedAt: number | null;
  lastVia: Via | null;
  lastReason: string;
  heard: string;
  hearing: "words" | "music" | "quiet" | "idle";
  confidence: number;
}

// ---- words ----------------------------------------------------------------

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' \n]+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

export function tailOf(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = tokenize(lines[lines.length - 1] ?? "");
  if (last.length >= 3) return last;
  const all = tokenize(text);
  return all.slice(-4);
}

/** Whisper's repetition loop ("the name of the Lord is the name of the Lord
 *  is…"), or more words than four seconds of singing can hold. */
export function looksLooped(text: string): boolean {
  const t = tokenize(text);
  if (t.length > 18) return true;
  const seen = new Map<string, number>();
  for (let i = 0; i + 2 < t.length; i++) {
    const k = `${t[i]} ${t[i + 1]} ${t[i + 2]}`;
    const n = (seen.get(k) ?? 0) + 1;
    if (n >= 3) return true;
    seen.set(k, n);
  }
  return false;
}

export function makeSlide(index: number, section: string, text: string): FSlide {
  return { index, section, text, tokens: tokenize(text), tail: tailOf(text) };
}

/** Inverse document frequency over every slide in the playlist, so "you",
 *  "the" and "lord" count for little and "excelsis" counts for a lot. */
export function buildIdf(songs: FSong[]): (t: string) => number {
  const df = new Map<string, number>();
  let n = 0;
  for (const s of songs)
    for (const sl of s.slides) {
      if (!sl.tokens.length) continue;
      n++;
      for (const t of new Set(sl.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  // A word in no lyric at all is an ad-lib ("oh", "yeah") or a mishearing:
  // it should dilute a match a little, not outweigh the rarest real word.
  const unknown = 0.5 * Math.log((n + 1) / 1.5);
  return (t) => {
    const d = df.get(t);
    return d ? Math.log((n + 1) / (d + 0.5)) : unknown;
  };
}

/** How much of what was heard this text explains (0..1), idf-weighted. */
function explains(heard: Set<string>, text: Set<string>, idf: (t: string) => number): { score: number; hits: number; mass: number } {
  let num = 0;
  let den = 0;
  let hits = 0;
  for (const t of heard) {
    const w = idf(t);
    den += w;
    if (text.has(t)) {
      num += w;
      hits++;
    }
  }
  return { score: den > 0 ? num / den : 0, hits, mass: num };
}

/** How much of `part` was heard (0..1), idf-weighted. */
function covered(part: string[], heard: Set<string>, idf: (t: string) => number): number {
  let num = 0;
  let den = 0;
  for (const t of new Set(part)) {
    const w = idf(t);
    den += w;
    if (heard.has(t)) num += w;
  }
  return den > 0 ? num / den : 0;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- the engine ------------------------------------------------------------

export const TUNING = {
  /** Whisper's own confidence: below these it was guessing at a band. */
  // Latin and held vowels ("Gloria… excelsis") score low as English, so the
  // gate is loose; a window still has to match the lyric to count for anything.
  minLangP: 0.3,
  minLogprob: -1.0,
  /** Locking onto a song from nothing wants cleaner hearing. */
  lockLangP: 0.5,
  strongLangP: 0.5,
  /** idf mass of matched words needed to move on hearing: ~two distinctive words. */
  minMass: 3,
  lockScore: 0.4,
  lockGap: 0.15,
  lockHits: 3,
  /** A slide ahead must explain this much of the last window to jump to it. */
  floor: 0.45,
  /** Share of the current slide's last line heard that means "it's ending". */
  tailCover: 0.5,
  /** Show the next slide this long before the clock's expected change. */
  lead: 700,
  /** Beyond the clock's expected change, move on without hearing it. */
  clockGrace: 1500,
  minGap: 1200,
  relockGap: 0.25,
  silenceRelease: 60_000,
  askEvery: 5000,
};

const PRIOR = (d: number) => (d === 0 || d === 1 ? 1 : d === 2 ? 0.8 : d > 2 ? 0.55 : 0.45);

export class FollowEngine {
  private idf: (t: string) => number;
  private byId = new Map<string, FSong>();
  private windows: { tokens: Set<string>; start: number; end: number; weak: boolean }[] = [];
  private song: FSong | null = null;
  private cur: number | null = null;
  private startedAt: number | null = null;
  private lastTrigger = 0;
  private ourTarget: { songId: string; slide: number; at: number; via: Via } | null = null;
  private clockOnly = 0; // consecutive clock moves without hearing the new slide
  private lastWords = 0; // last window with sung words
  private lastSound = 0; // last window that wasn't quiet
  private matchedCurAt = 0; // last time a window matched the current slide
  /** First sighting of the current slide's last line, and when it should end. */
  private tailSeenAt = 0;
  private endAt: number | null = null;
  /** The current slide was entered at its start (an advance from the one
   *  before), so its length is worth learning. Not after a lock or a jump. */
  private clean = false;
  private relockStreak: { id: string; n: number } | null = null;
  private backStreak: { slide: number; n: number; at: number } | null = null;
  private lastAsk = 0;
  private asking = false;
  private lastPrompt = "";
  view: FollowView = {
    song: null,
    songId: null,
    bpm: null,
    slide: null,
    section: "",
    dueAt: null,
    slideStartedAt: null,
    lastVia: null,
    lastReason: "",
    heard: "",
    hearing: "idle",
    confidence: 0,
  };

  constructor(
    public songs: FSong[],
    public timing: Timing,
    private opts: { modelReady?: boolean; prompt?: "none" | "current" } = {},
  ) {
    this.idf = buildIdf(songs);
    for (const s of songs) this.byId.set(s.id, s);
  }

  // ---- the clock ----

  /** Expected dwell of a slide (ms), rescaled if the song's tempo changed. */
  dwell(song: FSong, slide: number): number | null {
    const t = this.timing[song.id];
    const xs = t?.slides[String(slide)];
    if (!xs || xs.length < 1) return null;
    const m = median(xs)!;
    return t.bpm && song.bpm && t.bpm !== song.bpm ? (m * t.bpm) / song.bpm : m;
  }

  /** How long a sung line lasts in this song: this run's own pace once a
   *  couple of slides have gone by, else two bars at the arrangement's BPM
   *  (most worship lines are two bars of 4/4), else four seconds. */
  lineMs(song: FSong): number {
    const run = this.pace.get(song.id) ?? [];
    const bars = song.bpm ? (8 * 60_000) / song.bpm : null;
    if (run.length >= 2) return median(run)!;
    if (run.length === 1) return bars ? (run[0] + bars) / 2 : run[0];
    return bars ?? 4000;
  }
  /** The clock's number if it has one, else lines × line length. */
  expected(song: FSong, slide: number): number {
    const sl = song.slides[slide];
    const lines = Math.max(1, sl?.text.split(/\r?\n/).filter((l) => l.trim()).length ?? 1);
    return this.dwell(song, slide) ?? lines * this.lineMs(song);
  }
  private pace = new Map<string, number[]>();
  private notePace(song: FSong, slide: number, ms: number) {
    const sl = song.slides[slide];
    if (!sl?.tokens.length || ms < 1500 || ms > 60_000) return;
    const lines = Math.max(1, sl.text.split(/\r?\n/).filter((l) => l.trim()).length);
    const xs = this.pace.get(song.id) ?? [];
    xs.push(ms / lines);
    if (xs.length > 8) xs.shift();
    this.pace.set(song.id, xs);
  }

  private learn(song: FSong, slide: number, ms: number) {
    if (!this.clean) return;
    this.notePace(song, slide, ms);
    if (ms < 1500 || ms > 60_000) return;
    const t = (this.timing[song.id] ??= { bpm: song.bpm, slides: {} });
    // A tempo change invalidates nothing — store at the new tempo by scaling
    // the old observations once.
    if (t.bpm && song.bpm && t.bpm !== song.bpm) {
      const k = t.bpm / song.bpm;
      for (const key of Object.keys(t.slides)) t.slides[key] = t.slides[key].map((x) => Math.round(x * k));
      t.bpm = song.bpm;
    }
    if (!t.bpm && song.bpm) t.bpm = song.bpm;
    const xs = (t.slides[String(slide)] ??= []);
    xs.push(Math.round(ms));
    if (xs.length > 6) xs.shift();
    this.timingDirty = true;
  }
  timingDirty = false;

  // ---- inputs ----

  /** ProPresenter says this slide is live (our trigger or anyone's). */
  onLive(songId: string | null, slide: number | null, now: number): Action[] {
    const song = songId ? this.byId.get(songId) ?? null : null;
    if (!song || slide == null) {
      // Something outside the playlist (or nothing) is live.
      if (song == null && songId) this.release("Pro left the playlist");
      return [];
    }
    const ours = this.ourTarget && this.ourTarget.songId === song.id && this.ourTarget.slide === slide && now - this.ourTarget.at < 3000;
    if (this.song?.id === song.id && this.cur === slide) return [];
    if (this.song?.id === song.id && this.cur != null && this.startedAt != null && slide === this.cur + 1) {
      // Learn how long the slide lasted — from a person's advance, or from
      // ours when it came from hearing (a clock move would teach itself).
      const via = ours ? this.ourTarget!.via : "pro";
      if (via !== "clock") this.learn(song, this.cur, now - this.startedAt);
    }
    if (!ours) {
      this.view.lastVia = "pro";
      this.view.lastReason = "moved in ProPresenter";
      this.clockOnly = 0;
    }
    this.setPosition(song, slide, now);
    return this.promptAction();
  }

  onHeard(h: Heard, now: number): Action[] {
    if (h.quiet) {
      this.view.hearing = "quiet";
      if (this.song && now - Math.max(this.lastSound, this.lastWords) > TUNING.silenceRelease) this.release("quiet for a minute");
      return [];
    }
    this.lastSound = now;
    const sung =
      !!h.text.trim() &&
      !looksLooped(h.text) &&
      (h.langP == null || h.langP >= (this.song ? TUNING.minLangP : TUNING.lockLangP)) &&
      (h.logprob == null || h.logprob >= TUNING.minLogprob);
    if (!sung) {
      this.view.hearing = "music";
      return this.clockCheck(now);
    }
    const tokens = new Set(tokenize(h.text));
    if (tokens.size === 0) {
      this.view.hearing = "music";
      return this.clockCheck(now);
    }
    this.view.hearing = "words";
    this.view.heard = h.text;
    this.lastWords = now;
    // Weak: Whisper wasn't sure it heard English words. In an instrumental
    // it will "remember" the song's lyrics at about this confidence, so a
    // weak window can confirm where we are but never moves us by itself.
    const weak = (h.langP != null && h.langP < TUNING.strongLangP) || (h.logprob != null && h.logprob < -0.6);
    this.windows.push({ tokens, start: h.start, end: h.end, weak });
    while (this.windows.length && this.windows[0].end < h.end - 20_000) this.windows.shift();

    if (!this.song) return this.tryLock(now);
    const acts = this.checkSong(now);
    if (acts) return acts;
    return this.position(tokens, now);
  }

  onTick(now: number): Action[] {
    return this.clockCheck(now);
  }

  /** The model's answer to an "ask". */
  onModel(songId: string, slide: number | null, confidence: number, noise: boolean, now: number): Action[] {
    this.asking = false;
    if (!this.song || this.song.id !== songId || noise || slide == null || confidence < 0.6) return [];
    if (slide === this.cur || !this.song.slides[slide]) return [];
    return this.trigger(this.song, slide, "model", `model picked it (${Math.round(confidence * 100)}%)`, now);
  }

  modelFailed() {
    this.asking = false;
  }

  // ---- decisions ----

  private recent(ms: number): Set<string> {
    const out = new Set<string>();
    const last = this.windows[this.windows.length - 1]?.end ?? 0;
    for (const w of this.windows) if (w.end >= last - ms) for (const t of w.tokens) out.add(t);
    return out;
  }

  private songScores(heard: Set<string>): { song: FSong; score: number; hits: number }[] {
    return this.songs
      .map((song) => {
        const all = new Set(song.slides.flatMap((s) => s.tokens));
        return { song, ...explains(heard, all, this.idf) };
      })
      .sort((a, b) => b.score - a.score);
  }

  private tryLock(now: number): Action[] {
    const heard = this.recent(20_000);
    const [a, b] = this.songScores(heard);
    if (!a) return [];
    this.view.confidence = a.score;
    if (a.score >= TUNING.lockScore && a.hits >= TUNING.lockHits && a.score - (b?.score ?? 0) >= TUNING.lockGap) {
      const slide = this.bestSlide(a.song, this.recent(6000), null)?.slide ?? firstLyric(a.song);
      if (slide == null) return [];
      return this.trigger(a.song, slide, "heard", `heard ${a.song.name}`, now);
    }
    return [];
  }

  /** A different song clearly outscoring the locked one, twice running. */
  private checkSong(now: number): Action[] | null {
    const heard = this.recent(12_000);
    const scores = this.songScores(heard);
    const mine = scores.find((s) => s.song.id === this.song!.id)?.score ?? 0;
    const top = scores[0];
    if (top && top.song.id !== this.song!.id && top.hits >= TUNING.lockHits && top.score - mine >= TUNING.relockGap) {
      this.relockStreak = this.relockStreak?.id === top.song.id ? { id: top.song.id, n: this.relockStreak.n + 1 } : { id: top.song.id, n: 1 };
      if (this.relockStreak.n >= 2) {
        this.relockStreak = null;
        const slide = this.bestSlide(top.song, this.recent(6000), null)?.slide ?? firstLyric(top.song);
        if (slide != null) return this.trigger(top.song, slide, "heard", `switched to ${top.song.name}`, now);
      }
    } else this.relockStreak = null;
    return null;
  }

  private bestSlide(song: FSong, heard: Set<string>, cur: number | null) {
    type C = { slide: number; score: number; weighted: number; mass: number };
    let best: C | null = null;
    let second: C | null = null;
    for (const sl of song.slides) {
      if (!sl.tokens.length) continue;
      const { score, mass } = explains(heard, new Set(sl.tokens), this.idf);
      const d = cur == null ? 0 : sl.index - cur;
      const weighted = score * PRIOR(d);
      const cand = { slide: sl.index, score, weighted, mass };
      const better = (x: typeof cand, y: typeof cand | null) =>
        !y || x.weighted > y.weighted + 1e-9 || (Math.abs(x.weighted - y.weighted) <= 1e-9 && fwd(x.slide, cur) < fwd(y.slide, cur));
      if (better(cand, best)) {
        if (best && song.slides[best.slide].text !== sl.text) second = best;
        best = cand;
      } else if (song.slides[best!.slide].text !== sl.text && better(cand, second)) second = cand;
    }
    return best ? { ...best, second } : null;
  }

  private position(win: Set<string>, now: number): Action[] {
    const song = this.song!;
    const cur = this.cur;
    if (cur == null) return [];
    const here = song.slides[cur];
    const nextIdx = cur + 1 < song.slides.length ? cur + 1 : null;

    // 1) The current slide's last line is being sung → the next one is due.
    //    Guard: a slide whose last line repeats its first ("Gloria…" twice)
    //    must also have run long enough to be at its end.
    //    Hearing the last line START isn't its end: on a slow song a line
    //    lasts six or seven seconds. So note when it was first heard and
    //    move when a line's length has gone by (the tick does the moving).
    if (here?.tokens.length && nextIdx != null) {
      const tailHeard = covered(here.tail, win, this.idf);
      const curScore = explains(win, new Set(here.tokens), this.idf).score;
      if (curScore >= 0.3) this.matchedCurAt = now;
      const head = here.tokens.slice(0, Math.max(0, here.tokens.length - here.tail.length));
      const tailInHead = here.tail.length > 0 && here.tail.every((t) => head.includes(t));
      const elapsed = this.startedAt != null ? now - this.startedAt : 0;
      const longEnough = elapsed >= this.expected(song, cur) * (tailInHead ? 0.6 : 0.35) && elapsed >= 1500;
      const w = this.windows[this.windows.length - 1];
      const prev = this.windows[this.windows.length - 2];
      const prevTail = !!prev && covered(here.tail, prev.tokens, this.idf) >= 0.3;
      const trust = !w?.weak || prevTail;
      // When the last line was first heard counts from any window; moving
      // on it needs a trusted one.
      if (tailHeard >= 0.3 && longEnough && !this.tailSeenAt) this.tailSeenAt = this.lastWindowEnd();
      // A slide that sings the same line twice can't be placed by its words:
      // once it's confirmed being sung, it ends when its length has run.
      if (tailInHead && curScore >= 0.3 && this.startedAt != null && this.endAt == null) {
        this.endAt = this.startedAt + this.expected(song, cur);
      }
      if (tailHeard >= TUNING.tailCover && longEnough && trust) {
        if (!this.tailSeenAt) this.tailSeenAt = this.lastWindowEnd();
        // The line began about half a window before the window that first
        // caught it; it ends a line's length after that. A slide that sings
        // the same line twice can't be placed by its words — it ends when
        // its expected length has run.
        if (!tailInHead) this.endAt = this.tailSeenAt - 1500 + this.lineMs(song);
        if (this.endAt != null && now >= this.endAt - TUNING.lead) return this.trigger(song, nextIdx, "heard", "heard the end of the slide", now);
      }
    }

    // 2) Where does the last window place us? Not with words sung before
    //    our own last move — overlapping windows still hold them.
    const last = this.windows[this.windows.length - 1];
    if ((last?.start ?? 0) < this.lastTrigger - 1000) return [];
    const best = this.bestSlide(song, win, cur);
    if (!best) return [];
    this.view.confidence = best.score;
    const curScore = here?.tokens.length ? explains(win, new Set(here.tokens), this.idf).score : 0;
    if (best.slide === cur || song.slides[best.slide].text === here?.text) {
      if (best.score >= 0.4) this.clockOnly = 0;
      return [];
    }
    const d = best.slide - cur;
    // Moving on hearing alone wants real words: "the Lord, the Lord" fits
    // half the songs in the building.
    if (last?.weak || best.mass < TUNING.minMass) return [];
    // Catch-up: a slide just ahead is being sung — we are late, go now.
    if (d >= 1 && d <= 2 && best.score >= TUNING.floor && best.score > curScore + 0.15) {
      return this.trigger(song, best.slide, "heard", d === 1 ? "heard the next slide" : "caught up two slides", now);
    }
    // A jump elsewhere (a repeated chorus, a skipped verse, going back):
    // confident twice running, and never within 6 s of our own move (the
    // overlapping windows still hold the previous slide's words).
    const sinceMove = now - this.lastTrigger;
    if (best.score >= 0.6 && sinceMove > 6000) {
      // Two sightings of the same slide within ~6 s (a misheard window in
      // between doesn't reset it).
      this.backStreak =
        this.backStreak?.slide === best.slide && now - this.backStreak.at < 7000
          ? { slide: best.slide, n: this.backStreak.n + 1, at: this.backStreak.at }
          : { slide: best.slide, n: 1, at: now };
      if (this.backStreak.n >= 2) {
        this.backStreak = null;
        return this.trigger(song, best.slide, "heard", d < 0 ? "went back" : "jumped ahead", now);
      }
    }
    // Two different slides equally likely — let the model read the lyric.
    if (
      this.opts.modelReady &&
      !this.asking &&
      now - this.lastAsk > TUNING.askEvery &&
      sinceMove > 3000 &&
      best.score >= 0.4 &&
      best.second &&
      Math.abs(best.score - best.second.score) < 0.1
    ) {
      this.asking = true;
      this.lastAsk = now;
      return [{ type: "ask", song, current: cur, transcript: this.transcript(), expect: nextIdx }];
    }
    return [];
  }

  private lastWindowEnd(): number {
    return this.windows[this.windows.length - 1]?.end ?? 0;
  }

  private clockCheck(now: number): Action[] {
    const song = this.song;
    const cur = this.cur;
    this.view.dueAt = null;
    if (!song || cur == null || this.startedAt == null) return [];
    const nextIdx = cur + 1 < song.slides.length ? cur + 1 : null;
    // The last line was heard; its end is due. (Hearing beats the clock
    // here: a clock learned from last week's slightly-early moves would pull
    // every change earlier still.)
    if (nextIdx != null && this.endAt != null) {
      this.view.dueAt = this.endAt;
      if (now >= this.endAt - TUNING.lead) return this.trigger(song, nextIdx, "heard", "heard the end of the slide", now);
      return [];
    }
    const d = this.dwell(song, cur);
    if (nextIdx == null || d == null) return [];
    const endAt = this.startedAt + d;
    this.view.dueAt = endAt;
    if (now - this.lastTrigger < TUNING.minGap) return [];
    const here = song.slides[cur];
    const singingHere = now - this.matchedCurAt < 6000;
    // Pre-advance: the clock says it's ending and the singing is on this
    // slide (or it's a blank/instrumental slide with the band playing).
    if (now >= endAt - TUNING.lead && (singingHere || (!here.tokens.length && now - this.lastSound < 4000))) {
      if (this.clockOnly < 1) {
        this.clockOnly++;
        return this.trigger(song, nextIdx, "clock", "on time by the clock", now);
      }
    }
    // Catch-up: well past its usual length, the band is playing, nothing
    // heard places us here — hearing failed. One slide on the clock alone.
    if (now >= endAt + TUNING.clockGrace && now - this.lastSound < 4000 && !singingHere && this.clockOnly < 1) {
      this.clockOnly++;
      return this.trigger(song, nextIdx, "clock", "past its usual length", now);
    }
    return [];
  }

  // ---- effects ----

  private trigger(song: FSong, slide: number, via: Via, reason: string, now: number): Action[] {
    if (now - this.lastTrigger < TUNING.minGap && this.song?.id === song.id) return [];
    if (this.song?.id === song.id && this.cur === slide) return [];
    if (via !== "clock") this.clockOnly = 0;
    // Learn from our own hearing-driven advance too (the end was heard).
    if (via !== "clock" && this.song?.id === song.id && this.cur != null && this.startedAt != null && slide === this.cur + 1) {
      this.learn(song, this.cur, now - this.startedAt);
    }
    this.lastTrigger = now;
    this.ourTarget = { songId: song.id, slide, at: now, via };
    this.view.lastVia = via;
    this.view.lastReason = reason;
    this.setPosition(song, slide, now);
    return [{ type: "trigger", song, slide, via, reason }, ...this.promptAction()];
  }

  private setPosition(song: FSong, slide: number, now: number) {
    this.clean = this.song?.id === song.id && this.cur != null && slide === this.cur + 1;
    if (this.song?.id !== song.id) {
      this.windows = this.windows.slice(-1);
      this.relockStreak = null;
    }
    this.song = song;
    this.cur = slide;
    this.startedAt = now;
    this.backStreak = null;
    this.matchedCurAt = 0;
    this.tailSeenAt = 0;
    this.endAt = null;
    const sl = song.slides[slide];
    Object.assign(this.view, {
      song: song.name,
      songId: song.id,
      bpm: song.bpm ?? null,
      slide,
      section: sl?.section ?? "",
      slideStartedAt: now,
    });
  }

  private release(why: string) {
    if (!this.song) return;
    this.song = null;
    this.cur = null;
    this.startedAt = null;
    this.windows = [];
    Object.assign(this.view, { song: null, songId: null, bpm: null, slide: null, section: "", dueAt: null, slideStartedAt: null, lastReason: why });
  }

  /** Whisper hears better when it knows the words that are coming. */
  private promptAction(): Action[] {
    const song = this.song;
    // Never the lines still to come: prompted with them, Whisper "hears"
    // the next line before it is sung (seen in the replay) and Follow moves
    // early. The current slide only, or nothing.
    const text =
      song && this.cur != null && this.opts.prompt === "current" ? song.slides[this.cur]?.text.replace(/\s+/g, " ").trim() ?? "" : "";
    if (text === this.lastPrompt) return [];
    this.lastPrompt = text;
    return [{ type: "prompt", text }];
  }

  private transcript(): string {
    return this.windows
      .slice(-6)
      .map((w) => [...w.tokens].join(" "))
      .join(" / ");
  }
}

function firstLyric(song: FSong): number | null {
  return song.slides.find((s) => s.tokens.length)?.index ?? null;
}

function fwd(slide: number, cur: number | null): number {
  if (cur == null) return slide;
  const d = slide - cur;
  return d >= 0 ? d : 1000 - d;
}

// ---- the model's question ----------------------------------------------------

/** The Messages request for an "ask": whole lyric, where we think we are,
 *  what was heard. Answer is one line of JSON. */
export function askBody(a: Extract<Action, { type: "ask" }>, heardRaw: string) {
  const lyric = a.song.slides
    .map((s) => `[${s.index}]${s.section ? ` (${s.section})` : ""} ${s.text.replace(/\s+/g, " ").trim() || "(blank)"}`)
    .join("\n");
  return {
    max_tokens: 60,
    system:
      "You follow a live worship song and say which lyric slide is being sung right now. The transcript comes from speech recognition of a live band — words will be misheard. Repeated sections (choruses) appear more than once; prefer the one at or just after the current slide. Answer with ONE line of JSON only: {\"slide\": <number or null>, \"confidence\": <0..1>, \"noise\": <true if the transcript is not these lyrics>}.",
    messages: [
      {
        role: "user",
        content: `Song: ${a.song.name}\n\nSlides:\n${lyric}\n\nCurrent slide: ${a.current}${a.expect != null ? `\nExpected next: ${a.expect}` : ""}\n\nHeard in the last few seconds (oldest first):\n${heardRaw}`,
      },
    ],
  };
}

export function parsePick(reply: any): { slide: number | null; confidence: number; noise: boolean } | null {
  const text: string = (reply?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("");
  const m = text.match(/\{[^}]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      slide: typeof j.slide === "number" ? j.slide : null,
      confidence: Number(j.confidence) || 0,
      noise: !!j.noise,
    };
  } catch {
    return null;
  }
}
