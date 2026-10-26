# StageMics

**Radio mics that follow the show.** StageMics runs the actors' wireless mics on your sound desk scene by scene and cue by cue, so nobody has to remember which channel to unmute when Mary walks on. It also gives your backstage crew a phone page to confirm who is wearing which mic, so the sound desk knows without anyone getting on the radio.

**StageMics is an agent-ready app.** It was built with an AI coding agent, and it is meant to be run, changed and extended with one. Every button in the app is also a command an agent can call (an [MCP](https://modelcontextprotocol.io) server ships with it), and the instructions below let an agent discover *your* sound desk and adapt the app to it.

Out of the box it talks to the **Allen & Heath dLive**. Using a different desk? See [Make it work with your desk](#make-it-work-with-your-desk).

## What it does

**Show mode** (the sound operator)

- Scenes on the left, the actors in the scene on the right: a big card per person with their face, name and mic number, a **LIVE / MUTED** button and a fader.
- **Activate scene** turns on the right mics. **Next cue** moves through the scene: each cue says who is live, and everyone else in the scene is muted. **End scene** mutes the scene's mics. **MUTE ALL** is always in the top bar.
- **Voice effects** per mic: tap a face and pick one (for example "Heaven", a delay and a big hall for an angel's voice), light, medium or full. Effects can also be part of a cue.
- **What you see is what the desk says.** If someone presses mute on the desk itself, the card follows. A warning appears if a mic outside the scene is left on.
- **Music panel** for show-wide channels like the playback players (Dante 1 and 2 here): mute and level from any scene.

**Build mode** (before the show)

- Import the scenes from [LiveStage](https://github.com/crownemmanuel/livestage) (or add your own), pick each scene's cast, and write its cues in a grid (who is on in each cue, which effect, and whether the cue is fired by hand or by LiveStage).
- Characters with photos (or a placeholder face), effect presets, and the mic list: which desk input each mic is on, with the desk's own channel names read from the desk. Add more mics when you buy more packs.

**Backstage mic check** (the crew's phones)

- Scan the QR code. The phone shows the **next** scene's cast with their mic numbers. If a pack was swapped, tap the number and pick the new one. Tap **All good**.
- The sound operator sees a tick next to the scene: checked, by whom, when. If anyone's mic changes afterwards, the tick goes away. When a scene goes live, every phone moves on to the next one by itself.
- Works on the venue's network, or through Firebase over mobile data when the Wi-Fi is down.

**Driven by LiveStage** (optional)

- LiveStage, the show's video and lighting app, can send StageMics "scene taken", "next cue", "mute Joseph", "effect on" over the network. A marker on a song can mute an actor at the exact moment their recorded vocal starts, and turn the mic back on when it ends. If the song is stopped early, the mics go back to what the scene says.

## Install

Windows and macOS (Apple silicon): download the installer from [Releases](https://github.com/crownemmanuel/StageMics/releases). Installed copies update themselves (Build → Settings → Check for updates); an update never installs while a scene is active. Details: [docs/RELEASES.md](docs/RELEASES.md).

- **Windows**: the installer is not code-signed yet. If you see "Windows protected your PC", choose *More info → Run anyway*. Allow StageMics on private networks when Windows asks (phones and LiveStage reach it over the network).
- **macOS**: not notarized yet. After dragging it to Applications, run `xattr -cr "/Applications/StageMics.app"` once.

Then **Build → Desk**: the desk's network address, its MIDI channel, and choose **dLive desk** (until then it runs in *dry run* and sends nothing).

## Make it work with your desk

You do not need to know your desk's control protocol. **Give your AI coding agent (Claude Code, Codex, Cursor…) this repository and paste it the instructions below.** It works out what desk you have, how to reach it, what it can control, and what to change, and it checks with you before it touches anything that could make a sound.

> Use an agent that can run commands on the computer that is on the same network as the desk. Do it on a rehearsal day, not during a service.

<details open>
<summary><b>Instructions for your agent</b> (copy everything in the box)</summary>

```text
You are helping me set up StageMics (this repository) for my sound desk. StageMics runs actors' radio
mics scene by scene. Read README.md, AGENTS.md, docs/APP.md and shared/dlive.ts first.

SAFETY, for the whole task:
- My desk may be in use, and it drives real speakers. Until I say otherwise, send it ONLY read-only
  questions (names, mute states, fader levels). Never mute, unmute, move a fader, rename, recall a
  scene or change a send without asking me first and telling me exactly which channel and what for.
- Never change the desk's network, MIDI, or security settings yourself; tell me what to change and why.
- Test anything that writes against a pretend desk first (scripts/fake-dlive.ts is the pattern).

1. FIND OUT WHAT DESK I HAVE.
   Ask me the make and model, or ask for a photo of the desk or of its rear panel. Ask whether a
   stagebox / MixRack / I/O rack is part of it, and which unit the network cable goes into.
   Look up the official remote-control protocol for that model (MIDI over TCP, OSC, a vendor TCP
   protocol…), from the manufacturer's own documentation, and tell me what it lets us control:
   channel mute, fader level, sends to FX/aux, channel names, scene recall, and whether the desk
   reports changes back. Say clearly if something we need is not possible remotely.

2. CONNECT TO IT.
   Work out how this computer reaches the desk: check this computer's network interfaces and
   addresses, and ask me for the desk's IP address (tell me exactly where it is shown on the desk's
   screen for my model). If the computer is on a different subnet, explain the simplest fix (a second
   address on the same adapter, or plugging into the desk's network switch) and let me do it.
   Find the control port and any setting that must be switched on on the desk (for the dLive:
   Utility → Control → MIDI, base MIDI channel, TCP port 51325, no login). Then make a single
   read-only connection and read one channel's name to prove the link works. Show me the reply.

3. MAP MY DESK.
   With read-only questions only, read the names (and mute states and fader levels if the protocol
   allows) of every input channel, DCA/VCA, mute group and FX send/return. Show me a short table, and
   point out which inputs look like radio mics (names like "Drama 3", "RF 5", "Mic 6", "Lav", a
   character's name), which look like playback or music (Dante, Playback, Track, iPod), and which
   effects exist (reverb, hall, delay). Ask me to confirm the mic channels, how many radio mics we
   use, and which inputs are music players.

4. MAKE STAGEMICS SPEAK TO IT.
   - If it is an Allen & Heath dLive: nothing to code. Fill Build → Desk (address, MIDI channel,
     mic ↔ input table, "Detect from desk"), the Music panel channels, and the effect presets
     (which FX sends make the voice effects), using what we found.
   - If it is another desk: add a driver for it next to shared/dlive.ts with the same abilities
     (build the bytes or messages for mute, fader, send level, name, and the read-only questions,
     and parse what the desk sends back into the same events), then make app/server/desk.ts and
     app/server/engine.ts use the driver I choose in Build → Desk instead of calling the dLive
     functions directly. Keep the dLive working. Add a pretend version of my desk next to
     scripts/fake-dlive.ts, and extend app/check.ts so `pnpm check` runs against it.
   - Follow AGENTS.md: one command handler, MCP tools kept working, show files keep loading.
   Run `pnpm typecheck` and `pnpm check` and show me the result.

5. PROVE IT ON THE REAL DESK, WITH ME.
   Pick ONE spare or test channel with me. Tell me exactly what you will send, wait for my OK, then
   unmute it, mute it, move its fader, and read each change back. Ask me to confirm on the desk's own
   screen that the right channel moved. Then put it back exactly as it was and show me it is back.

6. HAND OVER.
   Write down in docs/APP.md (a section "Our desk") the model, address, port, settings, the channel
   map and anything surprising, so the next person or agent does not have to rediscover it.
   Tell me what is still untested.
```

</details>

### Running the show with an agent

The app ships an MCP server (`pnpm mcp`, tools for status, scenes, cues, mics, levels, effects, music channels, backstage next scene and panic). With it connected, you can ask your agent things like *"activate scene 7"*, *"put Heaven on Gabriel"*, *"bring Dante 1 down 3 dB"* or *"which scenes has backstage not checked yet?"*. Commands that reach the audience are marked as live, so a well-behaved agent asks before using them.

## Development

```bash
pnpm install
pnpm dev          # the desktop app (Tauri)
pnpm serve        # the service only: http://localhost:1450
pnpm fake-dlive   # a pretend dLive on 127.0.0.1:51325 (Build → Desk → address 127.0.0.1)
pnpm check        # end-to-end test against its own pretend desk
pnpm typecheck
```

How it is put together: [docs/APP.md](docs/APP.md). Releases and the updater: [docs/RELEASES.md](docs/RELEASES.md). Notes for AI agents working on the code: [AGENTS.md](AGENTS.md).

Never test writes against a desk that is in use: use `pnpm fake-dlive`.
