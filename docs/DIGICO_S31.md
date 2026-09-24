# DiGiCo S31 (experimental)

This fork adds an S31 console option using S-Series **general-purpose OSC** over UDP. It targets firmware **3 or newer**, with the console's default OSC addresses, boolean values and decibel ranges. It does not use the DiGiCo iPad protocol, SD/Quantum protocol, or Allen & Heath MIDI protocol.

The implementation has software tests, including a local UDP exchange. **It has not been validated on a physical S31.** Keep dashboard control disabled until the checks below pass on your console.

## Configure the desk and ProDeck

1. Connect the S31 and the ProDeck computer to the same network. Use stable IP addresses.
2. On the S31, open **Extensions → OSC Control**, enable OSC, and note its **Receive Port**. ProDeck suggests **8000**, but both settings must match; this is configurable, not a fixed protocol port.
3. Add the ProDeck computer's IP as the active controller. Set the controller's **Send Port** to **8001** (or another unused port chosen in ProDeck). Enable both **Send** and **Receive** for this controller. The S31 supports only one active general-purpose OSC controller at a time.
4. In ProDeck **Settings → Sound Console**, select **DiGiCo S31 (experimental)**, enter the console IP, match its receive port, and set **ProDeck UDP feedback port** to the controller Send Port. Enable mirroring and save.
5. In **OSC Commands**, confirm that the relevant commands are enabled and use default addresses and types/ranges. Mute uses boolean true/false (true = muted); fader uses floating-point dB. Do not normalize or invert these commands. If your session uses custom mappings, preserve/export them before making changes; this driver requires the defaults.
6. Press **Resend All** on the S31. ProDeck also queries channel names, mutes and faders on connection and periodically queries Input 1's mute for connection health. The mirror becomes connected only after valid feedback from the configured console IP. Allow UDP traffic through the computer's firewall if prompted.

The feedback port must be available on the computer; do not reuse ProDeck's separate generic OSC listener port. No MIDI base channel is needed.

## Supported controls and limits

- Channel names, mute state and fader levels, with admin-only controls through the existing dashboard controls. Existing ProDeck name writes are limited to eight printable ASCII characters.
- Fader feedback retains native dB precision, including levels below the shared legacy scale's -54 dB floor. S31 dashboard nudges use native dB values; -150 dB represents off. The legacy 0–127 API remains available for absolute settings.
- Integer snapshot recall through `/digico/snapshots/fire`, using the same 1-based row number entered in ProDeck. This first version exposes rows 1–500; it does not claim this is the desk's maximum snapshot capacity. Reordering snapshots changes which row is recalled. Verify numbering on your desk. Snapshot feedback is accepted on the same path if the desk emits it; otherwise the current snapshot remains unknown. No snapshot-name lookup is implemented.
- Only console feedback changes the S31 mirror. A successful UDP send does not prove a mute, fader, name or snapshot was applied.
- No colour, audio-meter, MIDI softkey, EQ, dynamics, routing or aux-send control. The existing desk watchdog is not supported for S31 in this version.
- An unanswered heartbeat disconnects and retries after roughly 12 seconds. Settings changes reopen the socket, and reconnection clears stale desk state. Channels without feedback remain unknown rather than being assumed unmuted.

## Channel mapping

The map follows DiGiCo's published V3.0.9 table. Check **OSC Commands → Help** on your actual session before enabling writes, especially the matrix and master assignments. The driver intentionally does not infer channel types from third-party SD/iPad mappings.

| Console OSC number | ProDeck key | Display |
| --- | --- | --- |
| 1–60 | `input:1`–`input:60` | Inputs (only existing, reported channels appear) |
| 70–93 | `bus:1`–`bus:24` | Bus 1–24, retaining the desk's channel names |
| 100–107 | `mtx:1`–`mtx:8` | Matrices |
| 110–119 | `dca:1`–`dca:10` | Control groups |
| 120 | `main:1` | Master |

Busses keep the same OSC number when changed between aux and group mode. Neutral bus keys avoid assuming a fixed aux/group split. The driver queries the maximum published ranges; an ordinary 48-input session need not respond for nonexistent channels. Writes to channels not yet reported by the desk are rejected.

## Hardware validation

Use a spare/test session and disconnected or otherwise safe outputs before a service:

1. Confirm the firmware, OSC address defaults, value types, ranges and channel map.
2. Compare names and states for an input, bus, matrix, control group and master. Verify both ends of each applicable range. Do not enable control for a range whose numbers differ from the documented map.
3. Change a mute on the desk and check ProDeck. Enable control on a test dashboard, mute/unmute the same channel from ProDeck and confirm that only that channel changes.
4. Verify faders at off, -90, -20, 0 and +10 dB; test a small nudge below -54 dB. A small nudge must not jump to the legacy scale's lower limit.
5. Rename a spare channel. Recall a harmless numbered snapshot and verify numbering and whether feedback is emitted. No local optimistic scene indication substitutes for this check.
6. Disconnect the network and verify the mirror goes offline, then reconnect and compare refreshed state. Change the configured feedback port and verify both sides must match.
7. Switch ProDeck back to an A&H or X32 model and confirm the S31 listener stands down.

## Protocol sources

- [DiGiCo S-Series V3.0.9 release notes, pp. 12–15](https://digico.biz/wp-content/uploads/2022/06/S21_S31-Release-Notes-V3.0.9.pdf): OSC setup, configurable command ranges, parameter queries, channel numbers and snapshot addresses.
- [DiGiCo S-Series version 3 announcement](https://digico.biz/digico-announces-new-software-update-for-s-series-consoles/): channel-processing OSC support in version 3.
- [S21_HiJack general-purpose OSC implementation](https://github.com/pob31/S21_HiJack): independently consulted for `/channel/{n}/mute`, `/fader`, `/name`, dB/off representation and packet-padding behavior. No source code was copied. Its channel-number assumptions differ from DiGiCo's published matrix/master table; this driver follows DiGiCo's table and requires hardware verification.

## Developer checks

Build the web assets before the Rust tests because ProDeck embeds `dist/`:

```sh
npm ci
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Network tests use local sockets and require loopback access. No test contacts a real console.
