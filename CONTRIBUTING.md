# Contributing

```bash
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm dev
```

- **Workspace layout.**
  - `apps/desktop` is the Electron app: `src/main` holds Electron-specific code (window, menu, IPC,
    composition root), plus `src/preload` and `src/renderer`.
  - `packages/core` is the engine with no Electron dependency.
  - `packages/shared` holds the types and IPC contract.
  - See [docs/architecture.md](docs/architecture.md).
- **Imports across packages** use subpath exports, e.g. `@helix/core/registry/service` or
  `@helix/shared/types`. Each package maps `./*` to `./src/*.ts`. Don't import with relative paths
  across package boundaries.
- **Dependencies.** Add each one to the package that imports it (`pnpm --filter @helix/core add undici`).
  `apps/desktop` keeps everything in `devDependencies` because its build bundles them.
- **Adding an API method.** Add it to `HelixApi` (`packages/shared/src/api.ts`), `API_SHAPE`
  (`packages/shared/src/channels.ts`), a zod schema (`packages/shared/src/schemas.ts`) and an
  implementation in `apps/desktop/src/main/ipc/handlers.ts`. `packages/shared/tests/channels.test.ts`
  fails if they drift apart.
- **Adding a registry provider.** Add a definition to `packages/shared/src/providers.ts`. The form is
  generated from it. Then handle its credentials and listing in
  `packages/core/src/registry/providers/index.ts`, and document it in `docs/registries.md`.
- **Keep `packages/core` free of `electron` imports** so it stays testable in plain Node. Electron
  adapters, such as the `safeStorage` keychain, live in `apps/desktop/src/main/context.ts`.
- **Before opening a PR:** run `pnpm check`. Also run `pnpm test:integration` if you touched the
  registry, docker or transfer code.
