# The Troubleshooter — "Ask ProDeck"

*Design spec. Extends design/ROUTING.md, which ruled out AI reasoning over the
map. This lifts that rule under strict conditions; the conditions are the
spec.*

## The job

A volunteer alone on a Sunday types, on their phone, *"the pastor's mic is
crackling"* or *"nothing from the keys"* or *"why is the stream quiet"*. They
do not know channel numbers, sockets or what a matrix is. ProDeck answers the
way the best sound tech in the building would if they were standing beside
them: one clarifying question if it truly needs one, then what it has already
checked, then the next physical thing to walk to and look at — in order, in
plain words, naming the actual receiver, socket and channel.

## What makes it safe to let a model talk

1. **It can only say what the map, the knowledge files and the live state
   say.** The model gets no general licence to invent a socket. Every
   building fact it uses must come from a tool result or the knowledge text,
   and its answer must name the node it came from. If the map doesn't know,
   it says so and hands over the generic checklist for that kind of thing.
2. **It never touches the desk.** Read-only tools. It may tell a person to
   unmute channel 39; it cannot unmute it.
3. **Its general sound knowledge is written down**, in `src/assist/doctrine.md`,
   and shipped with the app: signal-flow method, symptom → likely causes,
   wireless, Dante, gain structure, feedback, phantom, scenes, the rules of
   engagement during a service. The model is told to reason from that text,
   not from memory, so what it says is reviewable and editable.
4. **Every conversation is logged** on the booth (`assist-log.jsonl`) so the
   person who owns the room can read what was said and fix the knowledge.
5. **The key stays on the booth.** Phones call the booth; the booth calls
   Anthropic. The key is a secret setting, stripped from everything the
   gateway sends out.

## Architecture

```
phone / booth UI ── AskPanel ── assist.ts (agent loop, tools, prompt)
                                     │  invoke("assist_complete", body)
                               booth Rust proxy ── api.anthropic.com/v1/messages
                                     │  adds x-api-key, logs, rate-limits
                               knowledge/*.md · routing.json · live state
```

- **Agent loop in TypeScript**, because the walk engine, the map and the live
  overlay already live there and are unit-tested. The model calls tools; the
  tools are `routing.ts` functions. Phones run the same loop (they already
  hold the map and live state); only the raw completion goes through the
  booth.
- **Tools** (all read-only, all return map facts with node ids):
  - `find(query)` — people (this week's team via mic assignments), channels
    (map names and live desk names), sources, places, socket numbers.
  - `walk(node_id)` — the deterministic walk: live checks ✓/✗, then steps.
  - `channel(number)` — patch row + live desk state + inserts + twins.
  - `socket(pocket|number)` — the Stage view for one socket or pocket.
  - `watchlist()` — known issues.
  - `status()` — desk connected, PP connected, meter running, audio input
    signal, which plan/service is selected, who is on which mic.
- **System prompt** = doctrine + this church's knowledge files (verbatim,
  markdown) + a compact map digest (doors, buses, outputs, destinations,
  pockets, counts) + live status + the answer contract below.
- **Model**: `claude-sonnet-5` by default (fast, cheap, good at tools);
  `claude-opus-5` selectable. Max ~6 tool rounds, ~1.2k tokens output.

## The answer contract (in the prompt, verbatim in spirit)

- Ask **at most one** clarifying question, and only when the answer changes
  what to check. "Which singer?" is a good one. "Can you describe the
  problem more?" is not.
- Lead with what ProDeck already checked (from `walk`), as ticks and crosses.
- Then numbered steps, most likely first, one physical action each, naming
  the thing (receiver ULXD4Q-5-8 slot 7, stage socket 41, channel 39 on the
  desk). No menu paths the person can't see.
- Say when to stop and get the booth: anything involving the desk's routing,
  scenes other than the ones named safe, or power cycling shared gear
  during a service.
- Cite: every building fact carries its node in brackets, e.g. *[ch 39]*,
  *[stage 41]*, *[Waves LV1]*. The UI turns those into links to the walk.
- If nothing on the map matches, say that plainly and give the generic
  checklist for the kind of thing described. Never invent a number.
- Length: a phone screen. Short sentences. No preamble.

## Knowledge files

`<data dir>/knowledge/*.md` — the church's own dossier (for Cornerstone:
SYSTEM, CONSOLE, DANTE, LV1). Edited on the booth (Settings → Troubleshooter
lists them; the folder opens in Finder). Shipped example: one short
`README.md` explaining what to put there. Never in the repo.

## Settings

Settings → **Troubleshooter**: API key (secret), model, "Let crew phones ask"
(default on once a key exists), monthly call cap (default 500), and the log.

## Status

- **Phase 1 shipped to the booth 2026-09-23** (`23c42d9`…`0bf041e`). Real
  answers verified against the API: a wireless crackle → pack/receiver/battery
  steps with the desk ticks first; "nothing from the keys" → one clarifying
  question (stage keys vs playback keys); a silent stream → lobby test first,
  LV1, ATEM, scene 19. 5–12 s per answer, 1–4 tool calls on claude-sonnet-5.
- Account-level Anthropic keys need `assist_workspace_id`; the app says so.
- Cornerstone knowledge = the dossier copied into `<data>/knowledge/`.

## Phases

1. Rust proxy + secret setting + knowledge loader + log. TS agent loop with
   the six tools. AskPanel on Routing → No sound? and on the phone under No
   sound?. Doctrine v1. Help topic. Cornerstone knowledge copied in.
2. Streaming responses; "was this right?" thumbs that append to the log;
   surfacing recurring questions to the Routing page as watchlist candidates.
3. Voice on the phone (dictate the question), and reading the answer aloud.

## Explicitly out

- Any write to the desk, ProPresenter, Planning Center or the map from chat.
- Answers about people (who is on the team, phone numbers) beyond "who is on
  which mic this week".
- Running without a key: the panel simply isn't shown.
