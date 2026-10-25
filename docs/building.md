# Building & releasing

## Toolchain

- Node.js 22 or newer.
- pnpm 11. `corepack enable` installs the version pinned in `package.json` (`packageManager`).
- Docker is only needed for `pnpm test:integration`. The app itself runs without Docker; Pull to
  Docker and Local Images need a running engine.
- The Electron binary is downloaded on first launch, not at install time.
- `pnpm-workspace.yaml` keeps the unused `electron-winstaller` install script disabled; pnpm requires
  an explicit decision for every dependency build script.

## Monorepo tasks (Turborepo)

Every root script delegates to `turbo run <task>`. Turbo runs the task in each package that defines it,
in dependency order, and caches the results in `.turbo/cache`. Packages without a build step
(`@helix/core`, `@helix/shared`) are wired in through a `transit` task. Changing a file in `core`
therefore invalidates the cached `typecheck` / `build` / `test` of every package that depends on it.

| Command (from the repo root)                                                                   | Purpose                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                                                     | Electron + Vite with hot module reload (`@helix/desktop`)                                                                                                                          |
| `pnpm build`                                                                                   | Production bundles into `apps/desktop/out/` (main, preload, renderer)                                                                                                              |
| `pnpm start`                                                                                   | Build, then run the production bundle without packaging                                                                                                                            |
| `pnpm typecheck` / `pnpm lint` / `pnpm test`                                                   | Per-package static checks and unit tests (cached)                                                                                                                                  |
| `pnpm check`                                                                                   | `typecheck` + `lint` + `test` in one Turbo run                                                                                                                                     |
| `pnpm format` / `pnpm format:check`                                                            | Prettier across the repo                                                                                                                                                           |
| `pnpm test:integration`                                                                        | `@helix/core`: starts `registry:2` containers (anonymous + htpasswd), builds a fixture image, runs the integration suite, cleans up. Set `HELIX_IT_KEEP=1` to keep the containers. |
| `pnpm test:e2e`                                                                                | Builds, then drives the app with Playwright. Set `HELIX_E2E_EXECUTABLE=<packaged binary>` to test a packaged build.                                                                |
| `pnpm icons`                                                                                   | Regenerates `apps/desktop/resources/icon.png`; electron-builder derives `.icns` and `.ico` from it                                                                                 |
| `pnpm dist`                                                                                    | Package for the current OS                                                                                                                                                         |
| `pnpm dist:mac` / `dist:win` / `dist:linux` / `dist:all`                                       | Package for specific platforms                                                                                                                                                     |
| `pnpm dist:dir`                                                                                | Unpacked app directory, for quick local testing                                                                                                                                    |
| `pnpm clean`                                                                                   | Remove `out/`, `release/`, `.turbo/` and test artifacts in every package                                                                                                           |
| `./scripts/build.sh [mac\|win\|linux\|all\|dir] [--skip-tests] [--arch x64\|arm64\|universal]` | Full pipeline: clean → `pnpm install --frozen-lockfile` → icons → turbo typecheck/lint/test/build → electron-builder                                                               |
| `scripts\build.ps1 [-Target win\|dir] [-SkipTests] [-Arch x64\|arm64]`                         | The same pipeline on Windows (PowerShell)                                                                                                                                          |

To work on a single package, use a filter: `pnpm --filter @helix/core test`, or
`pnpm turbo run typecheck --filter=@helix/desktop...` to include its dependencies.

## Packaging

electron-builder runs inside `apps/desktop`, using `apps/desktop/electron-builder.yml`. The main and
preload bundles include every dependency, so the app contains only `out/`, `resources/icon.png` and
`package.json`. No `node_modules` are packaged, which avoids any trouble with pnpm's symlinked
layout. `extraMetadata.name` renames the scoped workspace package (`@helix/desktop`) to
`helix-x-docker-client` for artifact, executable and `.deb` names.

Artifacts are written to `apps/desktop/release/<version>/`.

| OS      | Artifacts                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| macOS   | `…-mac-arm64.dmg`, `…-mac-x64.dmg`, plus `.zip`                                                                     |
| Windows | `…-win-x64-setup.exe` and `…-win-arm64-setup.exe` (NSIS, per-user, choose directory), `…-win-x64-portable.exe`      |
| Linux   | `…-linux-x86_64.AppImage`, `…-linux-arm64.AppImage`, `…-linux-amd64.deb`, `…-linux-arm64.deb`, `…-linux-x64.tar.gz` |

## Cross-platform builds

From macOS, electron-builder can produce all three platforms (`./scripts/build.sh all`). This includes
Windows NSIS and portable builds without Wine as long as they are unsigned. Signed Windows builds, and
macOS builds in general, need their native OS. Use CI for releases.

## Code signing & notarization (optional)

Unsigned builds work. macOS Gatekeeper then asks users to right-click → Open the first time, and Windows
SmartScreen shows a warning. To sign, set these environment variables before packaging:

| Platform           | Variables                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS signing      | `CSC_LINK` (base64 or path of a _Developer ID Application_ .p12), `CSC_KEY_PASSWORD`. Or install the certificate in the login keychain. |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Notarization runs automatically when they are set.                          |
| Windows            | `CSC_LINK` / `CSC_KEY_PASSWORD` (Authenticode .pfx), or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`                                         |

Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to force an unsigned macOS build on a machine that has
certificates installed.

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`** runs on pushes and pull requests. It sets up pnpm through
  `pnpm/action-setup` and restores the Turbo cache, then runs `pnpm turbo run typecheck lint test build`,
  the integration tests, and E2E (under `xvfb`).
- **`.github/workflows/release.yml`** runs when you push a tag `v*`. It builds on `macos-latest`,
  `windows-latest` and `ubuntu-latest`, uploads the binaries as workflow artifacts, and attaches them
  to a **draft** GitHub Release. Add the signing secrets above to sign.

To release:

```bash
pnpm --filter @helix/desktop exec npm pkg set version=0.2.0   # the app version lives in apps/desktop/package.json
git commit -am "Release 0.2.0" && git tag v0.2.0
git push --follow-tags
```

## Project metadata

Before publishing, set `homepage` in `apps/desktop/package.json` to your repository or documentation URL. Debian
packages require it, and the in-app _Help → Documentation_ menu opens it. Also set `author` and
`linux.maintainer` in `apps/desktop/electron-builder.yml`.

## Auto-update

It is not enabled. To add it: `pnpm --filter @helix/desktop add electron-updater`, set a `publish` provider in
`electron-builder.yml`, and call `autoUpdater.checkForUpdatesAndNotify()` after the window is created.
