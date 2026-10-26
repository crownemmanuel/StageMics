# StageMics

Scene-by-scene radio-mic control for a live show on an **Allen & Heath dLive**, with a backstage mic check on the crew's phones. It is the sound half of [LiveStage](https://github.com/crownemmanuel/livestage) (the LED-wall show-control app), kept as its own small app so the mics never depend on the wall.

- **Show mode**: pick a scene, **Activate**, step **Next cue**: each cue says who is live, everyone else in the scene is muted. Big LIVE / MUTED buttons and a fader per actor, voice effects (a "Heaven" delay + hall) per mic, **MUTE ALL**, a **Music** panel for the Dante players, and what the desk itself reports (a mute pressed on the surface shows here too).
- **Build mode**: scenes imported from LiveStage, each scene's cast and cues, characters with photos, effect presets, mic ↔ desk input table (names read from the desk), more mics when you need them.
- **Backstage mic check** (phones, by QR code): the next scene's cast with their mic numbers; swap a pack, tap **All good**, and the sound desk sees a tick. On the local network, or through Firebase when the Wi-Fi is down.
- **LiveStage drives it** over OSC (scene taken, cue, mic, effect, restore), e.g. mute an actor at the second their recorded vocal starts in a track.

Windows and macOS. Installers and automatic updates: [Releases](https://github.com/crownemmanuel/StageMics/releases), see [docs/RELEASES.md](docs/RELEASES.md). Everything else: [docs/APP.md](docs/APP.md).

## Development

```bash
pnpm install
pnpm dev          # the desktop app
pnpm serve        # the service only, http://localhost:1450
pnpm fake-dlive   # a pretend desk on 127.0.0.1:51325 (Build → Desk → address 127.0.0.1)
pnpm check        # end-to-end test against its own pretend desk
pnpm typecheck
```

The real desk is used for live services: test writes against `pnpm fake-dlive`.
