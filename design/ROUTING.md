# Routing & the Troubleshooter

*Design spec — the contract for the Routing rebuild. Supersedes the Chain/Hop
model in `src/pages/Routing.tsx`.*

## The job

A volunteer alone at 9am on Sunday, a dead mic, no sound tech. They open
ProDeck on their phone, tap the person whose mic is dead, and get: what
ProDeck has already checked for them, and the one or two things left to walk
to and look at — in that order, in plain words.

The same data, on the booth screen, is the building's signal map: every
input and output drawn as boxes and lines, lit by what ProDeck can see live,
and editable by the church that owns it. **No church should need us to build
theirs.**

## Why the current Routing page isn't it

It has the right intent (its own header says "for the volunteer who has to
answer 'why is there no sound' alone") and the wrong model: a `Chain` is a
linear list of prose hops (`"Stage mics" → "Stage box"`). It cannot answer
"Ruth's mic" because it knows no channel numbers, packs, sockets or desk
state; it watches four coarse subsystems; and its seed describes an eMotion
LV1 nobody here owns. `routing.json` shipped in 1.0, so anything a church
saved must survive the rebuild (see Migration).

## The one insight the whole thing rests on

From Cornerstone's Routing Bible: *"Channel names change every service. Trust
the numbers."* Console channel 39 is channel 39 every week; who is singing
into it changes. So the map is keyed by **numbers that don't move** — socket,
port index, channel, bus — and the two things that do move arrive **live**
from systems ProDeck already talks to:

| changes weekly | ProDeck already has it |
|---|---|
| channel *names* | desk mirror (`avantis_state` names, all four desks) |
| who is on which mic | Planning Center mic assignments → `micDeskMap` |

That is why the walkthrough can say "Ruth's mic — channel 39 is open" while
the map itself says nothing about Ruth.

## The model

One graph. Nodes typed by **kind**; edges are the patch.

```
RoutingMap {
  schema: 2,
  verified: { at, by },              // whole-map stamp; rows carry their own
  nodes: Node[], edges: Edge[],
  rules: Rule[],                     // "gain belongs to the socket" — see below
  watchlist: KnownIssue[],           // faults already known; checked FIRST
}

Node {
  id, kind, label,
  ref?:  { port: "slink"|"dante"|"local"|"me"|…, index: number },   // the number that doesn't move
  bind?: { desk?: "input:39" | "bus:…", capture?: 7 },              // live overlay hooks
  steps?: string[],                  // church-edited; falls back to kind template
  verified?: at, dead?: boolean,     // dashed in the graph: "looks normal, goes nowhere"
  pos?: { x, y },                    // manual nudge only; layout is by kind
}
kind ∈ source | door | channel | bus | output | destination

Edge { from, to, transport?, verified?: at, dead?: boolean }
```

**Source kinds carry the checklists.** The upstream *type* determines what
to walk to, so a small set of source kinds ships with default steps a church
edits to its building:

| source kind | default steps (edited per church) |
|---|---|
| wireless pack | pack on · receiver RF light · battery · swap the pack, keep the receiver |
| stage socket / tie line | right socket (dead ones are dashed) · cable · try the free socket beside it |
| playback computer | app running · output device · channel routing on the machine |
| streaming / consumer source | app playing · output device · volume on the source |
| rack XLR | cable · the device itself |
| Dante device | online in Dante Controller · subscribed · clock |

**Rules** are the Bible's "three rules that explain most surprises" made
data, each attached to the situation it explains, so they surface *at the
hop* rather than as a preamble: *gain and 48V belong to the socket, so two
channels on one socket share one preamp; stereo pairs are odd/even; trust
numbers not names.*

**Watchlist** is "Things to watch": known faults with a symptom. Matching
symptom → shown first, before any walk. (Synth L and R from different
machines is a real example.)

## Three faces of one graph

### 1. Table — how a map gets built fast

Rows are console channels: `CH · NAME · PORT · SOCKET · UPSTREAM · (verified)`.
This is the patch list every sound tech already has. Paste a CSV/TSV and the
graph exists. Outputs get their own table: `PORT · OUT · FED BY · DRIVES`.
Names auto-fill from the desk mirror; typing a name only overrides the label.

### 2. Nodes — the graphs, live

The canvas view, and the one that answers "I want my graphs in there."

- **Layout by kind, not by hand.** Columns: source → door → channel → bus →
  output → destination, auto-arranged. Manual nudge allowed and remembered
  (`pos`), but a new node always lands in its column. Free-form placement is
  what makes node editors unreadable; the Bible's diagrams are readable
  because they never do it.
- **Connect by dragging** an output port to an input port. That is the whole
  editing gesture. Kinds constrain what can connect to what (a source can't
  wire straight to a bus).
- **Filters** as in the Bible: *Only SLink · Only Dante · Only Local · Show
  all* — by door/transport.
- **Live paint.** A channel bound to the desk shows mute/fader; an edge into
  a captured Dante channel shows signal; a dead socket is dashed; an
  unverified hop is dotted. The map *is* the status page.
- Implementation: `@xyflow/react` (React Flow, MIT) for pan/zoom/drag/connect,
  with dagre for the column layout. Booth-only bundle; phones never load it.

### 3. Walk — the troubleshooter

Phone, read-only, no AI. Entry: **a person** (this week's team, via mic
assignments), **a channel** (live desk names), or **a place** (stage panel,
lobby, stream). Then:

1. Watchlist match? Show it first.
2. Trace source → … → destination through the graph.
3. Run every live check available on that path. Each is ✓ / ✗ / *can't see
   from here*.
4. Present ✓s as done, then the *can't-see* hops as steps, most-likely first,
   with the relevant rule inline.

Example, from real Cornerstone data:

> **Ruth's mic — vox 3, pack 7**
> ✓ Desk channel 39 is open, fader at −4. Its twin, 53, is muted — normal, it's the duplicate.
> ✓ Desk connected · Dante in 43 patched.
> **Between Ruth and the desk, in order:**
> 1. Pack on? Receiver ULXD4Q-5-8, light 7 showing RF? *Battery is the usual one.*
> 2. Gain is set once for pack 7 and shared by 39 and 53 — check it on the input, not the channel.
> 3. Still nothing: swap the pack; the receiver stays.

Every ✓ is a place they didn't have to walk to.

Language rules for step text: second person, one action per line, name the
physical thing (receiver, light 7, socket 41), never a menu path they don't
have in front of them.

## Live bindings — generic across desks

Binding is by number, so it works for every supported desk without
per-desk code: `bind.desk = "input:39"` reads mute/fader/name from the mirror
map that Avantis, dLive, SQ and X32/M32 all populate with the same keys.
`bind.capture = 7` reads `audio:channels[6]` for signal on a Dante channel
routed to the booth's input. Unbound nodes simply have no live checks — the
walk still works, it just has more to walk to.

## Keeping it true

Maps rot; the Bible says so of its own outputs. So:
- every node and edge carries `verified: at`; the walk shows "map verified
  N weeks ago" and the Routing page nags past a threshold (default 90 days);
- **one-tap verification** on a hop from the walk itself ("this was right /
  this was wrong") — the person who just fixed the mic is the best verifier
  we will ever have;
- edits are versioned via the existing atomic-write + backup path.

## Templates and Cornerstone's map

- Ships with **one generic example** (a 16-channel church: stage box over
  Dante, a playback laptop, two wireless receivers) as the seed, clearly
  labelled *example — replace with yours*. The old LV1 seed goes.
- **Cornerstone's Bible is transcribed once** onto the booth's `routing.json`
  — all ~80 channels, sockets, subscriptions, packs, outputs, rules and
  watchlist — for Zach to verify on the Routing page. It never ships in the
  public build.

## Migration

`routing.json` schema 1 (Chain/Hop) is read and converted: each chain becomes
a linear set of untyped nodes/edges with the hop's `steps` preserved, flagged
*imported — assign kinds*. Nothing is dropped. Schema 2 writes only after a
successful read.

## Help

Topics in `src/help/topics.ts` (the canonical docs): *Building your routing
map* (table + paste), *Drawing the map* (nodes), *When something has no
sound* (using the walk), *Keeping the map verified*. `docs/ROUTING.md`
mirrors them for GitHub readers.

## Status

- **Phase 1 built 2026-09-23** (unreleased): `src/lib/routing.ts` (model,
  paste parser, migration, walk engine — 25 unit tests), `routingStore.tsx`
  (load/save + live overlay: desk mirror in dB, `audio:channels`, subsystem
  lights), `pages/Routing.tsx` (Channels table with edit/paste/steps/dead/
  verify, "No sound?" tab), `components/RoutingWalk.tsx` (picker + walk,
  shared), `mobile/CrewWalk.tsx` (Home → No sound?, More → No sound?).
  Booth saves emit `routing:changed`; phones re-read. Help topics
  `routing-map` and `routing-walk`; `docs/ROUTING.md` mirrors them.
- **Phase 2 built 2026-09-23**: `src/lib/routingLayout.ts` (fixed columns by
  kind, dagre for in-column order, filters, live paint, connect rules — 11
  tests) + `components/RoutingGraph.tsx` (React Flow, lazy chunk, booth-only).
  Nudge/connect/delete/add go through the page draft and Save.
- Cornerstone's Bible is transcribed onto the booth's `routing.json`
  (64 channels, 49 sources, 3 doors, 10 buses, 15 outputs, 8 destinations,
  8 watchlist items) from a one-off script kept outside the repo at
  `~/.prodeck/cornerstone-routing.json`. Awaiting Zach's verification pass.
- **Waves LV1 added 2026-09-23** from the `.emo` session (SQLite): dest
  `waves-lv1`, insert-send outputs (channel → output edges, allowed by
  `canConnect`), watchlist `w-waves-down`. Walking to a place now stops at
  the feeding channels and reads destination-first. LV1 findings live in
  `~/.prodeck/system/LV1.md` (never in the repo).
- Outputs are in the model and the walk (Places) already; the outputs
  *table* and in-app watchlist/rules editing remain Phase 3.
- One-tap verification from a phone needs a member-writable command
  (phones are read-only viewers); deferred to Phase 3.

## Phases

1. Model + migration + table view + CSV paste + walk engine + phone walk (inputs).
2. Node view with live paint and filters.
3. Outputs (tables, walk to destinations), watchlist, rules inline.
4. Help topics, generic example, Cornerstone transcription + verification pass.
5. Later: pull the input patch live from X32/M32 (`/ch/NN/config/source`) so
   that desk's map fills itself; optional Gemini front door that maps free
   text to a node and nothing more.

## Explicitly out

- Any AI reasoning over the graph. A model will confidently invent a socket.
- Free-form canvas placement as the primary layout.
- Reading A&H input patching over MIDI — the protocol does not expose it.
