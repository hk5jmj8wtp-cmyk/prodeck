# Auto-Follow, revisited — hear the lyric, land the slide on time

*Design spec for the second version of Follow (Captions → ProPresenter).
The first version ships today: Whisper every five seconds → token match →
optional Gemini pick → trigger through the Sunday playlist. This replaces
its brain and adds a clock.*

## What Zach asked for

"Hear lyrics, find the playlist in Pro, run the lyrics. On time of when it is
singing. Maybe learning the BPM of the song since we use MultiTracks so it can
follow without a problem."

Three jobs, in order of how often they matter:

1. **Land on the right song** the moment singing starts, from the Sunday
   playlist, without anyone clicking.
2. **Advance slides on time** — the line should be on screen as it is sung,
   not two seconds after Whisper heard it.
3. **Stay on time when hearing is poor** (a loud room, a mumbled verse, a
   guitar solo) by knowing how long each slide lasts for this song.

## Why v1 lags

- Whisper runs on five-second windows with no overlap, then the model call
  adds a second or two: a line is recognised three to seven seconds after
  it started.
- Every decision is made from the last ~14 words alone. Nothing knows that
  the chorus repeats or that verse 2 follows verse 1.
- There is no notion of time. The slide only moves when words match.

## The design

**Local first, model second, clock always.**

### 1. Hearing (Rust, unchanged engine, tighter loop)

Whisper stays local (audio never leaves the booth). Windows become 4 s with a
2 s hop (overlapping), and each caption line carries the wall-clock time the
window ended. That halves the recognition delay for the same CPU. Optional
later: whisper.cpp's streaming binary when installed.

### 2. Song lock (TypeScript, local)

While armed and no song is locked, score the last ~20 s of transcript against
every song in the playlist index (token overlap over the whole song, not one
slide). Lock when one song leads clearly (score gap ≥ 0.15 and ≥ 3 distinct
matched words). Locking triggers that song's first matching slide through the
playlist, exactly as v1 does. A lock is released when the plan's live item
changes, when a different song outscores the locked one for two consecutive
windows, or after 90 s of silence.

### 3. Position inside the song

Two estimators run at once and are reconciled:

- **The listener.** Local token match against the locked song's slides,
  biased to the current slide and the next two (repeats resolve forward).
  When the top two candidates are within 0.1 of each other, or the match
  floor isn't met for two windows, ask the model.
- **The model** (Claude Haiku 4.5 via the booth proxy, the same `assist`
  channel and key, separate call budget). Input: the song's full lyric with
  slide numbers and section names, the current slide, the last 40 words of
  transcript with timestamps, and the timing model's expectation. Output:
  slide number + confidence + "this transcript is noise" flag. It is asked
  only on ambiguity or a suspected section change — a few times a song, not
  every window.

### 4. The clock (TypeScript, learned)

Every time a slide is triggered (by Follow or by hand), record
`(song uuid, slide index, dwell seconds)`. Keep a median dwell per slide per
song in `follow-timing.json`, and per song a **tempo scale**: MultiTracks play
at a fixed BPM, so if Planning Center gives the song's BPM (arrangement
`bpm`) the dwell can be stored in beats and rescaled on a week when the
arrangement changes. The clock's job is to say "the current slide has run
its usual length; the next one is due" — which lets Follow:

- **pre-advance** at the expected moment when the last transcript words
  agreed with the end of the current slide;
- **hold** when the clock says the slide has 15 s left and the listener
  hears a stray match (a repeated line from the next chorus);
- **catch up** when hearing failed for a whole slide.

Confidence math: trigger when `listener ≥ floor`, or `model ≥ floor`, or
`clock says due AND listener agrees with the end of the current slide`.
Never on the clock alone beyond one slide.

### 5. What the operator sees

The Captions page shows: the locked song, the current slide, the next
expected slide and when (a small bar filling), which estimator made the last
move (heard / model / clock), and one **Nudge** pair (previous / next) that
also teaches the clock. Arm and disarm stay one button.

## Cost and safety

- Whisper local; only text goes to the model, as today.
- Model calls only on ambiguity: expect 5–15 per song. Separate monthly cap
  (default 2 000) from the troubleshooter's, same key.
- If the model is unreachable, v1's local behaviour continues.
- Follow never triggers outside the armed playlist; never during a non-song
  plan item unless the operator arms it there.

## Phases

1. Overlapping windows + timestamps; song lock; listener bias to current+2;
   Claude Haiku replaces Gemini for the pick (Gemini stays selectable). Tests
   on recorded transcripts.
2. The clock: dwell learning, pre-advance/hold/catch-up, the Captions page
   status bar, Nudge.
3. Planning Center BPM in beats; streaming Whisper when present.

## Open questions for Zach

- Does Planning Center hold BPM for your arrangements (Songs → arrangement →
  BPM)? If yes, phase 3 is cheap.
- Is a 2-second hop acceptable CPU on the booth Mac while the meter and NDI
  run? (Whisper `small` today; check `whisper_model`.)
- Which is worse on Sunday: a slide that changes 1 s early, or 2 s late?
  That sets the pre-advance bias.
