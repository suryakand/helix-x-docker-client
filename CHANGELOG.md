# Changelog

Entries go under **Unreleased**. The Release workflow (`.github/workflows/release.yml`) turns that section
into `## <version> — <date>` when it publishes a release and uses it as the release notes.

## Unreleased

First release.

- Master-password vault (Argon2id + AES-256-GCM), auto-lock, OS keychain / Touch ID unlock.
- Registry CRUD for Generic, Docker Hub, Harbor, Nexus, Artifactory, ECR, Google, ACR, GHCR and
  GitLab, with test connection, import/export and a ⌘K switcher.
- Import registries from `docker login` (config.json and credential helpers).
- Explorer with repositories, tags, manifest/config details, multi-architecture support, retag and delete.
  Tag summaries load only for visible rows, use HEAD plus a digest cache, use Docker Hub's API (no
  pull-quota cost), and run at most 4 at a time per registry.
- Pull to Docker without `docker login`, push from Docker, export/import `.tar`, copy between registries.
- Transfers: automatic retries with backoff (honours `Retry-After`), resumable layer downloads (HTTP
  Range), upload restarts after resets or token expiry, system notifications, dock/taskbar progress.
- Settings (security, network, Docker endpoint, transfers, diagnostics) and Preferences (Docker storage
  location, platform, appearance, behaviour).
- Built-in offline Help (sidebar, Help menu, F1) and a per-provider Setup guide in the Add registry dialog.
- Dialogs trap keyboard focus, restore focus on close, and Escape closes only the top-most dialog.
- macOS (dmg/zip), Windows (NSIS installer/portable) and Linux (AppImage/deb/tar.gz) installers, built and
  published by a one-click Release workflow that also bumps the version on `main`.
- pnpm 11 + Turborepo monorepo (`apps/desktop`, `packages/core`, `packages/shared`, `packages/tsconfig`);
  packaged apps ship without `node_modules`.
