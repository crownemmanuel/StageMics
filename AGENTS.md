# Agent notes

StageMics runs the actors' radio mics on a real Allen & Heath dLive that is also used for live church services. Start with [README.md](README.md), [docs/APP.md](docs/APP.md) and [docs/RELEASES.md](docs/RELEASES.md).

- **Never send writes to the real desk while developing** (mute, fader, send, name, colour, scene recall). Read-only questions are fine. Test writes with `pnpm fake-dlive` (127.0.0.1:51325) or `pnpm check`.
- Every command goes through one handler (`app/server/engine.ts`, table in `app/server/spec.ts`). The operator screen, backstage page, OSC from LiveStage, the API and the MCP (`app/mcp.ts`) all use it: a new feature needs its command there, and an MCP tool when an agent should reach it. Mark `live` / `destructive` / `readOnly` honestly.
- `shared/dlive.ts` and `shared/soundProtocol.ts` are shared with LiveStage (same files in both repositories): change them in both, and keep the OSC protocol compatible (bump `SOUND_PROTOCOL_VERSION` when it changes).
- Keep show files loading: migrate in `app/server/model.ts`.
- Verify with `pnpm typecheck` and `pnpm check` (set `SOUND_CHECK_HTTP` / `_OSC` if its ports are taken). Ask before pushing, tagging or releasing.
