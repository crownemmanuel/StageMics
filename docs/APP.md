# StageMics

A small show-control app for the actors' radio mics. It owns the connection to the Allen & Heath dLive and mutes / unmutes the drama mics scene by scene and cue by cue, puts "voice effects" on them (sends into the desk's FX units), and gives the crew a phone page for the backstage mic check. With the mics' audio coming in over Dante it also shows each pack's signal, warns when the next scene's packs are silent, and records the show as one track per character. LiveStage (the LED-wall app) drives it over OSC; an agent can drive it over MCP.

It is deliberately light and separate from LiveStage: a Node service (`app/server/`) and two small React pages (`app/ui/`, built to `app/dist/`), shipped as a Tauri desktop app for Windows and macOS that runs the service next to itself ([RELEASES.md](RELEASES.md)). Nothing from LiveStage's UI, no Three.js.

## Starting it

Installed: open **StageMics**. From the source:

```bash
pnpm dev            # the desktop app (builds the screens and the service executable first)
pnpm serve          # the service only (no window): open http://localhost:1450
pnpm ui:dev         # screens with hot reload on http://localhost:1452 (run pnpm serve as well)
pnpm ui:build       # build the screens into app/dist/
pnpm check          # end-to-end test against the pretend desk (never touches a real desk)
pnpm fake-dlive     # a pretend dLive on 127.0.0.1:51325 (see below)
pnpm mcp            # the MCP server (an agent starts it; see "Agents")
pnpm build:audio    # the Dante capture helper (native/audio, Rust); pnpm dev builds it too
```

The desktop app starts the service and quits it with the window. If a service is already answering on port 1450 (for example `pnpm serve`), the window uses that one instead.

Service options (arguments or environment):

| Argument | Env | Default |
| --- | --- | --- |
| `--data <dir>` | `SOUND_DATA_DIR` | `~/Library/Application Support/StageMics/` |
| `--dist <dir>` | `SOUND_DIST_DIR` | `app/dist` next to the server |
| `--http-port <n>` | `SOUND_HTTP_PORT` | 1450 |
| `--osc-port <n>` | `SOUND_OSC_PORT` | 1451 |
| `--desk-readonly` | `SOUND_DESK_READONLY=1` | off: only questions ever go to the desk |
| `--open` | | open the operator window once listening |

Once HTTP and OSC are listening it prints one machine-readable line, then keeps logging:

```
SOUND_READY {"url":"http://localhost:1450","http":1450,"osc":1451,"data":"…","pid":123}
```

SIGTERM / SIGINT save the show and the live state and close every socket. A port that is already taken makes it exit (code 2 for HTTP, 1 for OSC).

## Ports

| Port | What |
| --- | --- |
| 1450 TCP | operator screen `/`, backstage page `/backstage`, JSON API `/api/…`, WebSocket `/ws` |
| 1451 UDP | OSC commands from LiveStage |
| 1452 TCP | `pnpm ui:dev` only |
| 9202 TCP (out) | Shader's video recorder, when the link is on (StageMics is the client; host and port in Build → Settings) |

The service listens on every interface so phones on the LAN reach `/backstage`. The operator screen, its WebSocket and the API answer **only this computer** (a LAN visitor to `/` is sent to `/backstage`) unless Build → Settings → "Allow the operator screen from other computers" is ticked. The backstage page can only assign mics and confirm scenes. Requests from a web page on another origin are refused.

## Data

In the data folder, every write is a temp file + rename:

- `show.json`: mics → desk inputs, characters, scenes (cast, per-scene mic assignment, cues), effect presets. Versioned (`version`), migrated on load (`migrateShow` in `app/server/model.ts`); a file that cannot be read is kept as `show.json.broken-<time>` and the app starts from the demo show.
- `settings.json`: this computer's desk address, sync mode, cloud keys.
- `live.json`: the active scene / cue / effects and the send levels effects took over, so a restart shows where the show was. Nothing is re-sent to the desk on start.
- `shader-link.json`: the Shader link's outbox (scene markers Shader has not saved yet), the scene it last reported and its recent markers, so a restart neither loses nor repeats one.
- `photos/`: character photos. `sound.log`: the log (also on Build → Settings).

Recordings live apart from the data folder, in **StageMics Recordings** in the home folder unless Recorder → Recorder settings names another (an external SSD is a good place): see [Dante audio and the recorder](#dante-audio-and-the-recorder).

A first start seeds a demo show (the mock-up's cast and scenes). **Import from LiveStage** is the real path.

## What the operator sees

**Show mode**: scenes on the left; the scene header with **Activate scene**, **Next cue** (with the next cue's name) and **End scene**; the cue strip (more than 7 cues: 5 around the current one with "N earlier" / "+N more"); a card per cast member in mic order (compact when more than 6) with a big **LIVE / MUTED** toggle; tap the face or name for the voice-effect panel (None / presets, Light / Medium / Full). **MUTE ALL** in the top bar, the **All mics** drawer with all 12, an amber banner when a mic that is not in the active scene is live, status pills for the dLive, LiveStage (lime: OSC in the last 20 s) and sync, and the QR button for the backstage page.

What a card shows is what the **desk** reports: if someone mutes a channel on the surface, the card follows. While the desk link is down the screen says so, and mic changes wait and go out the moment it is back.

With the Dante input running (Build → Dante audio), each card has a level meter, a **REC** tag while the mic is being recorded, and "No signal — check the pack" when its pack sends nothing. While a scene is live, a line under the cues says whether the **next** scene's packs are all sending, or names the silent ones in amber so someone can check them before it starts. The backstage phones show "NO SIGNAL · CHECK PACK" or "● SENDING" next to each person. The top bar shows **Dante** (lime: audio coming in) and, while recording, a red **REC 0:42:13** pill (amber when something needs a look) that opens the Recorder. With no Dante input nothing that needs audio is shown.

**Build mode**: the scene's cast (add / remove), the cue grid (rows = cues, columns = cast, ON / OFF cells, effect and trigger columns, add / reorder / delete), characters (name, male / female placeholder, photo upload, default mic, colour), effect presets, desk mics + connection, backstage sync with the QR code, settings + log, and **Import scenes from LiveStage**.

## Rules the app follows

- A cue lists who is live; everyone else in the scene's cast is muted. Mics not in the cast are left alone (the stray banner shows them).
- Applying a cue mutes first, then sets effects, then opens mics. Activating another scene also mutes the previous scene's mics that the new one does not use and clears their effects.
- **End scene** mutes the active scene's mics and clears effects. **MUTE ALL** mutes all 12. Both write the mutes at once (nothing waits on fades or the network) and fire on the button's press, not its release; MUTE ALL goes over the WebSocket and over HTTP as well.
- A backstage mic swap in the live scene re-applies the current cue so the right people stay live, and mutes a mic nobody in the scene wears any more.
- Effects: each preset is a list of sends from the mic's channel into FX sends at a dB level, with fade in / out. Amount: Light −10 dB, Medium as set, Full +6 dB (clamped to +10). Fades step the send level about 20 times a second. Clearing puts each send back to the level it had before the effect took it (remembered, also across a restart; −∞ if unknown).
- On connect the app asks the desk (read-only) for the names and mutes of the 12 mic inputs, and the names / mutes / faders of the FX sends, returns and DCAs the presets use, and the send levels. Build → Effect presets warns when a return is at −∞ or a DCA is muted (on the show desk FX return 3 "DELAY" was parked at −∞ and DCA 10 "FX" muted: the effect is then silent).
- **Dry run** (the default on a fresh install): nothing is sent; the screen plays the desk. Switch to "dLive desk" in Build → Desk.

## Dante audio and the recorder

### The input

The mics' audio reaches this computer through **Dante Virtual Soundcard** (DVS): the dLive's Dante card sends the radio mics, Dante Controller routes them to this computer, and DVS shows them as an ordinary audio input (Core Audio on a Mac, WDM on Windows). StageMics only listens: nothing in this section ever writes to the desk.

1. Install DVS and start it with at least as many channels as there are mics, at 48 kHz.
2. On the dLive, patch each radio mic to a Dante output from its **input socket / preamp** (or a direct out that does not follow the mute), so StageMics hears a pack while it is muted. The recorder does the muting itself.
3. In Dante Controller, route those outputs to this computer's DVS channels, in mic order if possible.
4. Build → **Dante audio**: choose *Dante Virtual Soundcard*, pick the device, and set each mic's Dante channel (default: mic n on channel n; "Number them in order" from any first channel). Leave one empty for a mic that is not on Dante.

The sample rate is whatever DVS runs at (StageMics never changes the Dante clock). **Test signal** is a pretend feed (a tone per channel that comes and goes like speech) for trying everything without a desk; "pack off" on a mic makes it silent. On a Mac the app needs microphone access (System Settings → Privacy & Security → Microphone; the installed app has the usage text). An unsigned build may ask again after an update. When every channel is pure digital silence the Dante page says so (DVS stopped, or no permission).

How it reads the device: `stagemics-audio` (native/audio, Rust with cpal) ships next to `mics-server` and is started by it with the Dante channels it needs. It copies them out of the audio callback into a lock-free ring (about 5 s) and streams them to the service over stdout. If it stops (DVS restarted, device unplugged) or nothing arrives for 2 s, the service starts it again with back-off (1 s … 10 s). Lost audio is counted, never hidden.

**No signal**: a mic whose level stays below −70 dBFS (Build → Dante audio → No signal) for 2 s has no signal. A receiver whose pack is off sends digital silence; a pack that is on sends at least room noise.

**Always recorded**: channels the recorder keeps the whole time, whatever the mutes (a reference mix for the editor, audience mics). Build → Dante audio → Always recorded.

### Recording

Recorder tab → **Record**. The rules:

- One track per **character**, for the whole recording. A mic is written only while it is live, as the desk reports it (cues, buttons, OSC, someone on the surface: all the same); muted time is silence.
- The audio goes to whoever wears that mic in the live scene, so when Mary moves from pack 1 to pack 3 between scenes her audio stays on Mary's track. A mic that is live with nobody in the scene's cast on it (a stray, or no scene active) goes to a "Mic n" track.
- 100 ms before an unmute and 250 ms after a mute are kept (Recorder settings), so the first and last syllable survive a late mute. Opened again within those 250 ms, the same stretch just carries on.
- On disk a recording is made of **segments**: one mono 24-bit WAV per stretch of one mic, from when it opens to when it is muted, the scene changes or the person on it changes. Each is finished (sizes written, synced) as it closes; open ones get their sizes written every 2 s and are synced every 6 s, and `session.json` (what is where on the timeline) is replaced atomically on every change.
- The **Recorder** tab says at a glance whether it is working: the time, *Recording: 3 tracks going to disk · last write 0.2 s ago* (or exactly what is wrong), who is being written right now, a lane per track showing where there is sound, the disk space, and warnings (no audio coming in, a slow disk, low space, mics without a Dante channel). **Mark** drops a marker the editor sees.
- **A recording only ends when you press Stop.** If the app stops while recording (crash, power, quit), the open segments are repaired from what is on disk at the next start, and if that is within 10 minutes the recording carries on on the same timeline, with silence (and a marker) for the time it was away. Older ones are just closed ("closed after a stop"). The same goes for the audio stopping mid-show: the recording waits and goes on when it is back, placed by the clock.
- The app does not install an update while recording.

The timeline is in samples of the Dante feed from when Record was pressed, so every track is sample-aligned with every other. After the input restarts, the new stretch is placed by the computer's clock.

### Export (for the video editor)

On a recording in the Recorder tab:

- **Export full show**: one WAV per person, every one exactly as long as the recording, silent where their mic was muted. They all start together: put them at the same point on the timeline.
- **Every scene**, or **One scene…**: the same, cut to each time a scene was live (a scene run twice gives "take 1", "take 2"). Only that scene's people.
- *One file per radio mic instead*: one file per mic, whoever wore it.

Files are mono 24-bit Broadcast WAVs whose time stamp is the time of day they start (for syncing to camera timecode). Where a track goes from silence to sound or back there is a 10 ms fade, so nothing clicks. Each folder has `markers.csv` (scenes, cues, marks, gaps with times) and `About these files.txt`. You can export while recording: scenes that have ended are complete.

```
StageMics Recordings/2026-10-26 19.02 Joseph/
  session.json              tracks, segments (start, length in samples), scenes, markers
  segments/0007 Mary (mic 3).wav …
  Export/Full show/01 Mary.wav, 02 Joseph.wav … markers.csv, About these files.txt
  Export/Scene 7 - Gabriel at the Well/…
```

A WAV holds about 8 hours of mono 24-bit at 48 kHz; export scenes for anything longer.

## Shader video recorder

Shader (the camera app, `~/Documents/Projects/shader`) records the cameras. StageMics sends it a marker at every **scene start** and **scene end**, and at every **Mark** (Recorder tab, or Build → Settings → Send a test marker), so the video editor finds each scene in the footage. The contract both apps follow is Shader's `docs/stagemics-markers.md`; the sender is `app/server/shader.ts`, and `pnpm fake-shader` is a pretend Shader to try it with.

- **Turn it on** in Build → Settings → Shader video recorder: the Shader computer (`127.0.0.1` when it is this one), its port (9202) and the pairing key Shader shows. A **Video** light in the top bar then says *REC* (Shader is recording and has every marker), *not recording*, *N waiting* or *not answering*.
- **HTTP JSON**, StageMics is the client. Every 2 s it asks `GET /recorder/v1/session` (the heartbeat: which take is recording), measures the clocks with `POST /recorder/v1/clock/probe`, and posts each marker to `POST /recorder/v1/sessions/<take>/events`, one at a time in order.
- **Each marker** has a fixed id, the time it happened on this computer's clock and the measured offset to Shader's clock (so it lands on the right frame even when the two computers' clocks disagree), the scene's id, number and name, the cue and the cast with their mics, and the position in StageMics' own Dante recording when one is running. Going straight to the next scene sends the old scene's end, then the new scene's start, at the same moment.
- **Nothing is lost or doubled**: markers are written to `shader-link.json` before they are sent and retried, byte for byte, until Shader answers saved or duplicate. A restart in the middle of a scene does not send it again.
- **A marker belongs to the take that was recording when it happened**, never to a later one. While Shader is not recording, scene changes are not sent (the card lists them as *not sent*). When a take starts in the middle of a scene, Shader gets that scene with its real, earlier start time (`alreadyLive`).
- It only reads what is live: nothing here reaches the desk.

## Desk setup

On the dLive: Utility → Control → MIDI. MIDI over TCP on port 51325 (no login; 51327 is TLS and is not used), base MIDI channel 12 on the show desk. The app spreads over channels N…N+4 as in `shared/dlive.ts`. In Build → Desk set the address (192.168.1.70 on the show network), port 51325 and base channel 12, then choose "dLive desk".

Mic k is desk input 76 + k by default (inputs 77–88, named Drama1 … Dram12 on the show desk). **Detect from desk** reads the names of inputs 1–128 and maps mics by names like `Drama 3`, `Drama3`, `Dram12`, `Radio 4`, `RF5`, `Mic 6`.

## Import from LiveStage

Build → Import scenes from LiveStage:

- **This computer's LiveStage show**: `~/Library/Application Support/org.salvation.livestudio/project.json` (`%APPDATA%\org.salvation.livestudio\` on Windows).
- **LiveStage while it runs**: asks the open app over its agent bridge (port 1431, the token in `~/.salvation-live/agent-1431.token`) with the read-only `list_scenes` and `status` commands only. Needs LiveStage's MCP server running (it hosts the bridge).
- **A show file**: `project.json`, or `show.json` from a `.slshow` package, picked in the browser; or a path to a file or a `.slshow` folder.

Scene ids are LiveStage's (`scene_…`), codes are LiveStage's display numbers (`7`, `2.1`, the same rule as `src/core/groups.ts`). Re-importing merges: scenes that still exist keep their cast and cues (name and code updated), new scenes are added, scenes LiveStage no longer has are marked "Gone from LiveStage" and kept until you delete them. The first real import removes the demo scenes; characters stay.

## OSC protocol (UDP 1451)

Defined in `shared/soundProtocol.ts`. Every argument is a string or int32; commands set a state, never toggle, so sending twice is harmless. `who` is a mic number (`"3"`), a character id or a character name (case-insensitive); a character resolves to their mic in the active scene (else the selected scene, else their default mic). Scene ids are LiveStage scene ids (codes and names work too).

| Address | Arguments | Does |
| --- | --- | --- |
| `/sound/scene/select` | s:sceneId | Show the scene on the operator screen; no mic changes |
| `/sound/scene/activate` | s:sceneId | Activate the scene and apply its first cue |
| `/sound/scene/end` | | Mute the active scene's mics and leave it |
| `/sound/cue/go` | s:sceneId i:cue (1-based) | Apply exactly that cue |
| `/sound/cue/next` | | Apply the active scene's next cue |
| `/sound/mic` | s:who i:live (1/0) | Set one mic live or muted |
| `/sound/fx` | s:who s:preset ("none" clears) [s:amount] | Voice effect on one mic |
| `/sound/restore` | | Re-apply the active cue |
| `/sound/panic` | | Mute every mic |
| `/sound/ping` | i:version | Answer with `/sound/hello` |

Replies go to the address and port of the last `/sound/ping`:

| Address | Arguments | When |
| --- | --- | --- |
| `/sound/hello` | i:protocolVersion s:appVersion i:deskConnected | After a ping |
| `/sound/state/mic` | i:mic s:name i:live | Whenever a mic changes, from any source (cue, operator, the desk surface) |
| `/sound/state/cue` | s:sceneId i:cue (0 = none) | Whenever the active cue changes |

Bundles are accepted. Errors (unknown scene, no such cue) are logged, not answered.

## Backstage mic check

The phone page (`/backstage`): two chips at the top, **LIVE** (the scene on stage) and **NEXT** (the scene to check now), each with a tick when it is checked; tapping one makes the phone follow it. By default the phone follows NEXT, so when the operator takes a scene live the phone moves on to the following one by itself, buzzes and shows "Next up: scene … Check the mics." The arrows browse any scene (the phone then stops following until a chip is tapped). The scene's cast is listed with their mic numbers; tap the big number for a 1–12 grid showing who holds each (offstage holders dimmed), pick one to assign (swaps if a cast member had it), and **All good** confirms the scene.

**Mic checks without the radio.** A check records who, when, and exactly which person was on which mic (the phone sends the list it was showing). It counts only while the scene still matches: a mic swap clears it, and a change to the cast or a default mic turns it amber ("changed since the check"). The operator sees a lime tick next to each checked scene in the scene list and "Backstage checked · name · time" under the scene title. NEXT normally follows the running order (the scene after the live one that has a cast); **Send to backstage as next** on any scene points the phones at it instead (it stays until that scene goes live), and **Ask to check again** clears a check. Workflow: while scene N runs, backstage checks N+1; the operator sees the tick before taking it. A change goes to the Sound app at once and updates that scene's mic mapping; the operator can undo it in Build ("Undo backstage mic changes").

The QR code (top bar button, or Build → Backstage) encodes the page's address. Two sync modes, chosen there:

### 1. Local network (default, real time)

The QR code is `http://<this computer's LAN address>:1450/backstage`. If the computer has several addresses, pick the one the phones' Wi-Fi is on. Phones talk to the service over a WebSocket.

### 2. Cloud (when the Wi-Fi is down and phones use mobile data)

Firebase **Realtime Database** over REST and server-sent events (no SDK). The Sound app signs in anonymously, claims `/sound/<showId>/<joinKey>/owner`, mirrors what the page needs to `…/show` (scenes, casts, characters with a 64 px photo thumbnail, no full photos), and streams `…/backstage` (`assign/<scene>/<character> = mic`, `stamp/<scene>`, `checked/<scene>`). Per scene the newer change wins. The same backstage page works from a static host: the QR code carries the database URL, the public API key, the show id and the join key in the URL's `#c=…` (the part after `#` is never sent to the web server); the page signs in anonymously and talks straight to the database.

The rules (`firebase/database.rules.json`): nobody can read or list `/sound` or `/sound/<showId>`; a signed-in user who knows a path `/sound/<showId>/<joinKey>` (join key ≥ 20 characters, 24 random base64url by default) can read it and write only `backstage` (mic numbers 1–32, timestamps, `{by, at}` checks); only the owning Sound app can write `show`, and `owner` can be set once. **New key** in Build → Backstage cuts off old QR codes.

#### Setting up cloud sync (you do this; nothing is deployed by the app)

1. In the Firebase project (the same one as LiveStage's cloud sync works): **Build → Realtime Database → Create database**.
2. **Authentication → Sign-in method → Anonymous: enable.**
3. Publish the rules: paste `firebase/database.rules.json` in Realtime Database → Rules, or `cd firebase && npx firebase-tools deploy --only database --project <project>`. (This does not touch the Storage rules.)
4. Host the backstage page: `pnpm ui:build`, then host the contents of `sound/dist/` (only `backstage.html` and `assets/` are needed). For Firebase Hosting add to `firebase/firebase.json`: `"hosting": { "public": "../sound/dist" }` and run `npx firebase-tools deploy --only hosting --project <project>`. The page URL is then `https://<project>.web.app/backstage.html`.
5. In the Sound app, Build → Backstage → Cloud: paste the web config (`const firebaseConfig = {…}`, it needs `apiKey`, `projectId`, `databaseURL`), set **Hosted page** to the URL from step 4, and switch the mode to **Cloud**. The QR code then points at the hosted page.

Until a hosted URL is set, the cloud QR code uses this computer's address (handy for testing, useless without the LAN).

#### Trying cloud mode without a project

```bash
pnpm emulator   # Firebase Auth (9099) + Realtime Database (9000) emulators with the rules (Java 11+)
```

Then in Build → Backstage → Cloud set Project `demo-sls`, any API key (e.g. `fake-api-key`), Emulator host `127.0.0.1`, and switch to Cloud.

## Agents (MCP)

`sound/mcp.ts` is a stdio MCP server that talks to the running service's API (`SOUND_HTTP_PORT` to pick the port). Add it to an MCP client as `node /path/to/livestage/sound/mcp.ts`.

| Tool | Marks | Does |
| --- | --- | --- |
| `status` | read-only | Desk link, active scene / cue, every mic's live state as the desk reports it, effects, LiveStage and sync |
| `list_scenes` | read-only | Scenes with code, id, cast with mics, cue labels |
| `activate_scene` | live | Activate a scene (first cue) |
| `cue_go` | live | Apply one cue |
| `next_cue` | live | Next cue of the active scene |
| `end_scene` | live | Mute the active scene's mics and leave it |
| `mic` | live | One mic live or muted |
| `fx` | live | Voice effect on one mic |
| `panic` | live, destructive | Mute every mic |
| `recorder_status` | read-only | Recording? Still writing (seconds since the last write), who is being written, the Dante input, disk space, warnings, exports |
| `start_recording` | | Start recording the show |
| `stop_recording` | destructive | Stop the recording (files kept) |
| `mark_recording` | | A marker at this moment |
| `list_recordings` | read-only | Recordings with length, tracks, scenes |
| `export_recording` | | Export one file per person: the show, every scene, or one scene |
| `audio_devices` | read-only | Audio inputs on this computer |
| `video_recorder_status` | read-only | The Shader link: connected, recording which take, markers waiting, the last markers and what happened to each |
| `mark_video` | | A marker in Shader's video recording at this moment |

## JSON API

All on `http://localhost:1450`, this computer only:

- `GET /api/ping`, `GET /api/status`, `GET /api/state` (show, runtime, settings, links, log), `GET /api/commands` (the command table).
- `POST /api/cmd` with `{"cmd": "...", "args": {...}}`, or `POST /api/<cmd>` with the args as the body. Answers `{"ok": true, "result": …}` or `{"ok": false, "error": "…"}` (400).
- `POST /api/photo/<characterId>` with `{"data": "data:image/jpeg;base64,…", "thumb": "data:…"}`.
- `GET /api/qr?text=…`: a QR code as SVG.

Every command (`app/server/spec.ts`) goes through `Engine.run()` in `app/server/engine.ts`: the operator screen, the backstage page, OSC, the API, MCP and the cloud all use the same handler, which validates, changes state, sends the desk its bytes and tells every screen.

## The pretend desk

`pnpm fake-dlive` (or `node scripts/fake-dlive.ts --port 51325 --host 127.0.0.1 --midi 12`) is a TCP server that speaks the dLive's MIDI over TCP: it keeps mutes, faders, names, colours and send levels, answers the "get" questions like the desk, logs every message, and relays every change to the other connected clients (so a second client can play someone on the surface). Seeded like the show desk: inputs 77–88 named Drama1 … Dram12 (muted), mono FX sends 2 "HALL" and 3 "DELAY", FX return 3 "DELAY" at −∞, DCA 10 "FX" muted. `kill -USR2 <pid>` prints its state.

## Safety notes

- A fresh install starts in **dry run**: nothing reaches a console until someone chooses "dLive desk" (and confirms the address).
- The app only ever writes mutes of the 12 mic inputs and send levels from those inputs into the presets' FX sends. It never sends faders, names, colours or scene recalls.
- The Dante input, the signal alerts and the recorder only read audio; they never send anything to the desk.
- Everything else it sends is a question (names, mutes, faders, send levels), including a heartbeat every 4 s that notices a dead link within ~13 s and reconnects with backoff (0.5 s … 10 s). Mutes and unmutes written in the 20 s before a link was found dead may not have arrived, so they wait ("Waiting for the desk") and go out again when it is back.
- `SOUND_DESK_READONLY=1` lets you look at a live desk with only questions going out (mutes and sends are logged, not sent).
- The desk is shared with church services: the dLive's own scenes may change channel names or mutes; the app shows what the desk reports and does not fight it.

## Code

| File | What |
| --- | --- |
| `shared/dlive.ts`, `shared/soundProtocol.ts` | dLive bytes and parser; the OSC contract with LiveStage (shared, read-only for this app) |
| `app/server/model.ts` | data model, defaults, demo show, migrations (also used by the UI) |
| `app/server/logic.ts` | pure rules: who wears which mic, what a cue means, resolving `who` |
| `app/server/engine.ts` | the command handler, cue application, fades, desk events |
| `app/server/desk.ts` | TCP link with reconnect and heartbeat |
| `app/server/osc.ts` | OSC encode / decode and the UDP listener |
| `app/server/http.ts` | static files, API, uploads, WebSocket, access rules |
| `app/server/importer.ts` | LiveStage show files, packages, the agent bridge; merge |
| `app/server/cloud.ts` | Realtime Database mirror (REST + SSE) |
| `app/server/audio.ts` | the Dante input: the helper's packets, the test signal, restarts, meters, no-signal |
| `app/server/recorder.ts` | the recorder: gating by mutes, segments, crash repair and carrying on, export |
| `app/server/wav.ts` | mono 24-bit Broadcast WAV writing, size patching, repair |
| `native/audio/`, `scripts/build-audio.ts` | `stagemics-audio`, the capture helper (Rust, cpal), and its build into `src-tauri/binaries/` |
| `app/server/main.ts`, `args.ts`, `window.ts`, `store.ts` | wiring, options, app window, files |
| `app/ui/` | operator app (`index.html`: Show, Recorder, Build) and backstage page (`backstage.html`) |
| `app/mcp.ts`, `app/check.ts` | MCP server, end-to-end check |
| `src-tauri/`, `scripts/build-sidecar.ts`, `scripts/release.ts`, `.github/workflows/release.yml` | the desktop app, the service executable, releases and updates ([RELEASES.md](RELEASES.md)) |
| `scripts/fake-dlive.ts` | the pretend desk |
| `firebase/database.rules.json` | Realtime Database rules for the cloud backstage |
