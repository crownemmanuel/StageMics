# Releases and app updates

StageMics updates itself from the GitHub releases of [crownemmanuel/StageMics](https://github.com/crownemmanuel/StageMics/releases), the same way LiveStage does, but from its own repository so the two apps never offer each other's updates.

```
build computer                    GitHub Actions                       sound computer (installed app)
pnpm release 0.2.0        →      Release workflow                     "Update 0.2.0" pill in the top bar
git push origin HEAD v0.2.0      builds Windows + macOS,              → Install 0.2.0 and restart
                                 signs the update files,                (only when no scene is active)
                                 publishes the release + latest.json
```

## On the sound computer

- A few seconds after the app starts, and every six hours after, it asks GitHub whether a newer version is published. It never downloads, installs or restarts on its own.
- When there is one, an **Update 0.2.0** pill appears in the top bar. **Build → Settings → App → Check for updates…** opens the same dialog any time.
- **Install and restart** downloads the update, stops the mic service, installs and opens the new version. **It refuses while a scene is active**: end the scene first. The desk keeps every mic exactly as it is while the app restarts.
- The show, settings and photos live in the data folder (`~/Library/Application Support/StageMics`, `%APPDATA%\StageMics`), which an update does not touch. Never change the identifier in `src-tauri/tauri.conf.json`.

## Cutting a release

The version lives in `package.json`; `src-tauri/tauri.conf.json` reads it from there, and the release script keeps `src-tauri/Cargo.toml` and `Cargo.lock` equal. The workflow refuses a tag that does not match.

1. Commit the work that goes into the release (on `main`).
2. `pnpm release 0.2.0` (or `patch` / `minor` / `major`; `--notes "…"` for your own notes, `--dry-run` to look first). It commits the version files and tags; it pushes nothing.
3. `git push origin HEAD v0.2.0` starts the build.
4. Watch **Actions → Release** (about 15 to 25 minutes). The release stays a draft until both builds succeed and `latest.json` lists Windows and macOS, then it is published.

A version with a suffix (`0.2.0-beta.1`) is published as a pre-release: apps never offer it.

| File | For |
| --- | --- |
| `StageMics_<version>_x64-setup.exe` (+ `.sig`) | Windows installer, and the file the Windows app updates from |
| `StageMics_<version>_aarch64.dmg` | macOS (Apple silicon) installer |
| `StageMics_<version>_aarch64.app.tar.gz` (+ `.sig`) | The file the Mac app updates from |
| `latest.json` | What installed apps read |

## One-time setup on GitHub

1. Create the **public** repository `crownemmanuel/StageMics` (installed apps download updates without signing in).
2. Push `main`.
3. Add the update signing key as two repository secrets (**Settings → Secrets and variables → Actions**). It is the same key LiveStage uses, so its public half is already in `tauri.conf.json`:
   - `TAURI_SIGNING_PRIVATE_KEY`: `pbcopy < ~/.tauri/salvation-live-studio.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: `pbcopy < ~/.tauri/salvation-live-studio.key.password`
4. Cut the first release, install it by hand from the release page; later versions arrive through the app.

## Building on this computer

- `pnpm build:installer`: an installer for this computer (`src-tauri/target/release/bundle/`) without update files, so no key is needed.
- `pnpm dev`: the desktop app in development (builds the screens and the service executable first).
- `pnpm serve`: the service alone from source (no desktop window; open http://localhost:1450).

## How it fits together

- The app is the service in `app/server` (Node). `scripts/build-sidecar.ts` bundles it with esbuild and turns it into one executable with Node's single-executable support (`src-tauri/binaries/mics-server-<target>`), which the installer puts next to the app. Homebrew's Node cannot do that step; the script then fetches the official Node build of the same version from nodejs.org (checked against its SHA-256 list) into `.cache/`.
- `src-tauri/src/lib.rs` starts that executable, shows its screen (http://127.0.0.1:1450) in the window, and stops it when the app quits. If the service is already running (a previous copy, or `pnpm serve`), the window uses it.
- `src-tauri/capabilities/default.json` lets that local screen use the updater and restart.
- `app/ui/src/lib/updater.ts` and the dialog in `app/ui/src/main.tsx`: check, download, stop the service, install, restart; refused while a scene is active.
- `.github/workflows/release.yml` and `scripts/release.ts`: as in LiveStage.

The installers are not code-signed with a Windows certificate or an Apple Developer ID yet: Windows may show "Windows protected your PC" on the first install (**More info → Run anyway**), and on macOS run `xattr -cr "/Applications/StageMics.app"` once after installing.
