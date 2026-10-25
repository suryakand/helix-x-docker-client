# Changelog

## Unreleased

- Tag table: summaries load only for visible rows, use HEAD plus a digest cache, use Docker Hub's API
  (no pull-quota cost), and run at most 4 at a time per registry.
- Transfers: automatic retries with backoff (honours `Retry-After`), resumable layer downloads (HTTP
  Range), upload restarts after resets or token expiry, system notifications, dock/taskbar progress.
- Built-in offline Help (sidebar, Help menu, F1) and a per-provider Setup guide in the Add registry dialog.
- Import registries from `docker login` (config.json and credential helpers).
- Dialogs trap keyboard focus, restore focus on close, and Escape closes only the top-most dialog.
- Converted the repository to a pnpm 11 workspace orchestrated by Turborepo: `apps/desktop`,
  `packages/core`, `packages/shared` and `packages/tsconfig`.
- The desktop bundle now includes all dependencies, so packaged apps ship without `node_modules`
  (the macOS DMG is about 9 MB smaller).

## 0.1.0 — 2026-10-24

First release.

- Master-password vault (Argon2id + AES-256-GCM), auto-lock, OS keychain / Touch ID unlock.
- Registry CRUD for Generic, Docker Hub, Harbor, Nexus, Artifactory, ECR, Google, ACR, GHCR and
  GitLab, with test connection, import/export and a ⌘K switcher.
- Explorer with repositories, tags, manifest/config details, multi-architecture support, retag and delete.
- Pull to Docker without `docker login`, push from Docker, export/import `.tar`, copy between registries.
- Settings (security, network, Docker endpoint, transfers, diagnostics) and Preferences (Docker storage
  location, platform, appearance, behaviour).
- macOS (dmg/zip), Windows (NSIS/portable) and Linux (AppImage/deb/tar.gz) packaging, plus CI release workflow.
