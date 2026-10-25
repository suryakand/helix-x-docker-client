# Architecture

## Workspace

| Package           | Path                | Depends on   | Contents                                                                                                     |
| ----------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `@helix/desktop`  | `apps/desktop`      | core, shared | Electron main entry (`src/main`: index, window, menu, context, ipc), preload, React renderer, e2e, packaging |
| `@helix/core`     | `packages/core`     | shared       | vault, store, registry, docker, transfer. No Electron imports, so it is testable in plain Node               |
| `@helix/shared`   | `packages/shared`   | —            | types, `HelixApi`, channel list, zod schemas, provider definitions                                           |
| `@helix/tsconfig` | `packages/tsconfig` | —            | `base.json`, `node.json`, `web.json`                                                                         |

Packages expose source through subpath exports (`"./*": "./src/*.ts"`). For example,
`import { RegistryService } from '@helix/core/registry/service'`. electron-vite bundles them into
`apps/desktop/out`, and Turborepo (`turbo.json`) orchestrates and caches the tasks.

## Processes

```
┌──────────────────────────── Renderer (Chromium, sandboxed) ────────────────────────────┐
│ React 19 + TypeScript + Tailwind 4 · TanStack Query (server state) · Zustand (UI state) │
│ apps/desktop/src/renderer/src/{app,pages,components,stores,lib,i18n}                    │
└──────────────── window.helix (typed bridge, apps/desktop/src/preload) ────────────────────┘
                     │ ipcRenderer.invoke("<ns>.<method>", ...args)   ▲ "helix:event"
                     ▼                                                │ (vault, job, docker, registries-changed)
┌──────────────────────────────── Main process (Node) ────────────────────────────────────┐
│ ipc/handlers.ts   zod-validates every call, enforces "vault must be unlocked",           │
│                   wraps results as {ok,data}|{ok:false,error}                            │
│ context.ts        composition root: builds services, auto-lock, event broadcast          │
│ ── @helix/core ──                                                                         │
│ vault/            Argon2id + AES-256-GCM vault, optional OS keychain unlock              │
│ store/            JSON files in userData (registries, settings, preferences, jobs)       │
│ registry/         RegistryClient (v2/OCI), auth challenges, providers, RegistryService   │
│ docker/           Engine API client (unix socket / named pipe / tcp), endpoint and       │
│                   storage-location detection                                             │
│ transfer/         BlobStore (layer cache), archive reader/writer, JobManager             │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The renderer has no Node access (`contextIsolation`, `sandbox`, no `nodeIntegration`). It can only call
the methods listed in `packages/shared/src/channels.ts`. Each call is validated in the main process
against `packages/shared/src/schemas.ts`. A unit test checks that both lists match.

## Shared contract (`packages/shared/src`)

| File           | Purpose                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| `types.ts`     | Domain types: registries, image details, jobs, settings, preferences, Docker status |
| `api.ts`       | `HelixApi`, the typed surface exposed as `window.helix`                             |
| `channels.ts`  | Dependency-free method list (used by the sandboxed preload)                         |
| `schemas.ts`   | zod schemas for every IPC argument tuple                                            |
| `providers.ts` | Declarative provider definitions; the add/edit form is generated from these         |

## Registry layer

`RegistryClient` (`packages/core/src/registry/client.ts`) implements the Docker Registry HTTP API v2 / OCI
Distribution spec on top of `undici`:

- **Auth.** The first request goes out anonymously. On a `401`, the client parses `WWW-Authenticate`:
  - **Basic:** it sends the saved credentials.
  - **Bearer:** it requests a token from `realm`, passing `service` and `scope` and using Basic credentials. Tokens are cached per scope set and refreshed early. Later requests attach authorization up front.
- **Pagination.** It follows the `Link: <…>; rel="next"` header. Cursors are checked to stay on the same origin and under `/v2/`, so credentials can't be sent to another host.
- **Uploads.** HEAD checks whether a blob exists, then the client tries a cross-repository mount, then does `POST` → single streamed `PATCH` → `PUT ?digest=`.
- **Integrity.** Manifest digests are checked when fetched by digest. Blob digests are checked while streaming into the blob store.
- **Retries** (`registry/retry.ts`). Requests without a streamed body are retried up to 4 times with exponential backoff and jitter on connection resets, timeouts and 429/502/503/504, honouring `Retry-After` (capped at 30 s). Permanent errors (401/403/404, TLS, unknown host) fail immediately.
- **Resumable downloads** (`transfer/operations.ts` `fetchBlob`, `transfer/blob-store.ts` `ResumableBlob`). Bytes go to `<digest>.partial`, which survives failures. A retry asks for `Range: bytes=<offset>-`; if the server answers 200 instead of 206, the partial file is discarded and the download starts over. The sha256 is computed incrementally and re-synced from disk after an interrupted write. A per-blob lock stops two jobs writing the same partial file.
- **Upload restarts.** `uploadBlob` restarts the whole session (POST → PATCH → PUT) with a fresh stream after a transient failure, rolling back reported progress. A 401 in the middle of a streamed PATCH refreshes the bearer token and restarts the upload instead of failing.

`providers/index.ts` adapts each registry type:

| Type                             | Credentials → Basic auth                              | Repository listing                                          |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| generic, nexus, artifactory, acr | username / password                                   | `/v2/_catalog` (optional prefix filter)                     |
| dockerhub                        | Docker ID + PAT                                       | `hub.docker.com/v2/repositories/<ns>` (JWT login)           |
| harbor                           | user / robot account                                  | Harbor `/api/v2.0/…/repositories`, falls back to `_catalog` |
| ecr                              | AWS keys → `GetAuthorizationToken` (cached ~12h)      | `DescribeRepositories`                                      |
| gcr                              | `_json_key` + SA JSON, or `oauth2accesstoken` + token | `_catalog`                                                  |
| ghcr                             | user + PAT                                            | GitHub Packages API                                         |
| gitlab                           | user + token                                          | GitLab `groups                                              | projects/:id/registry/repositories` |

If listing is denied, the explorer still lets you open repositories by name and pin them.

**Tag summaries** (size, created, platforms in the tag table) are designed to be cheap, because Docker Hub counts manifest GETs as pulls:

- The renderer only requests summaries for rows that are scrolled into view (`useInView`).
- `RegistryService.tagSummary` resolves the digest with a HEAD request (not counted) and serves any tag whose digest it already knows from an in-memory cache (immutable, LRU-capped at 5,000 entries).
- On Docker Hub, the summary comes from the Hub REST API (`/v2/repositories/<repo>/tags/<tag>`) instead of manifest GETs.
- At most 4 summaries per registry are resolved concurrently (`util/limiter.ts`).

**Importing `docker login` credentials** (`store/docker-logins.ts`):

- The importer reads `~/.docker/config.json` (or `$DOCKER_CONFIG`): inline `auths`, `credHelpers`, and the default `credsStore` via `docker-credential-<helper> list|get`. Common helper locations are added to `PATH`, because GUI apps start with a minimal one.
- Each server is mapped to a provider type:
  - Docker Hub, GHCR, ACR (including identity tokens) and GitLab map to their own types.
  - GCP logins map to the Google provider (`_json_key` → service-account JSON, `oauth2accesstoken` → access token).
  - ECR's 12-hour tokens are reported as not importable.
  - Everything else becomes a generic registry.
- Scanning returns usernames and sources only. The import call re-reads the secrets inside the main process.

## Built-in Help

`apps/desktop/src/renderer/src/lib/docs.ts` imports `docs/user-guide.md`, `registries.md`, `troubleshooting.md` and `security.md` with Vite's `?raw`, so they are bundled at build time. `marked` renders them with heading ids. Turbo lists `$TURBO_ROOT$/docs/**` as an input of the desktop `build`, so editing a doc invalidates the cache.

`DocView` handles links:

- Cross-doc links switch documents.
- Anchors scroll within the page.
- `https://` links open in the system browser.

The Add registry dialog shows the provider's section (`docSection` by `<a id>` anchor) in a stacked modal. `packages/shared/tests/providers.test.ts` checks that every provider's `docsAnchor` exists.

## Local Docker integration

`docker/endpoint.ts` finds the Engine API the same way the docker CLI does. It checks these in order:

1. The endpoint set in Settings
2. `DOCKER_HOST` (and `DOCKER_CERT_PATH` / `DOCKER_TLS_VERIFY`)
3. The current docker context (`~/.docker/config.json` → `contexts/meta/<sha256(name)>/meta.json`)
4. Well-known sockets for Docker Desktop, Engine, OrbStack, Colima, Rancher Desktop and Podman

**Pull to Docker** never writes into Docker's data directory. Docker owns that directory: it's
`/var/lib/docker` on Linux, and it sits inside the Docker Desktop VM disk on macOS and Windows. Writing
files there directly would corrupt it. Instead:

1. The app resolves the manifest for the chosen platform. The default is the engine's own os/arch.
2. It downloads the config and layers into the verified blob cache, using the credentials saved in the app.
3. It streams a combined OCI-layout + `manifest.json` tarball into `POST /images/load`, the same call
   `docker load` uses. The daemon makes no registry request, so no `docker login` is needed and registry
   login restrictions in Docker Desktop don't apply.
4. It tags the image `registry.host/repo:tag`, plus an optional extra tag, and remembers it for the
   "pulled via Helix-X" filter.

`docker/storage.ts` reports where images live: `DockerRootDir` from `/info`, plus the VM disk image path
on the host. Docker Desktop's path comes from `settings-store.json` (`DataFolder`), or from the default
`Docker.raw` / `docker_data.vhdx` locations. Colima, OrbStack and Rancher Desktop have similar
detection. The **Preferences → Docker image storage** panel shows this information.

## Transfers

`JobManager` (`transfer/jobs.ts`) runs a queue with configurable concurrency. Every job has an
`AbortController`. Progress events are throttled to about 7 per second, and history (the last 200 jobs)
is saved to `jobs.json`.

| Job    | Steps                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| pull   | resolve → download blobs → stream archive into `/images/load` → tag                                                                      |
| export | resolve → download → write `<file>.partial` → rename                                                                                     |
| import | extract tar (gzip detected, path traversal refused) → read OCI or legacy layout → push blobs + manifest (or the whole index if complete) |
| push   | `GET /images/{name}/get` → extract → push                                                                                                |
| copy   | resolve one platform or the full index → mount / exists check → lazily fetch missing blobs into the cache → upload → manifest(s)         |
| load   | stream a `.tar` file into `/images/load`                                                                                                 |

### Archive format

Archives are written in the layout `docker save` has produced since Docker 25:

```
oci-layout
index.json            # OCI index, annotated with io.containerd.image.name / org.opencontainers.image.ref.name
manifest.json         # Docker: [{Config, RepoTags, Layers}]
blobs/sha256/<hex>    # config, layers (kept compressed exactly as in the registry), manifest
```

The reader also accepts plain OCI layouts and the legacy `docker save` format (`<id>/layer.tar` plus
`<hex>.json`). For the legacy format it computes digests and builds an OCI manifest.

## Persistence (`app.getPath('userData')`)

| File                                | Contents                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `vault.json`                        | KDF params, wrapped data key, encrypted secrets, optional keychain-wrapped key |
| `registries.json`                   | Registry metadata only: no secrets                                             |
| `settings.json`, `preferences.json` | User configuration (deep-merged with defaults on upgrade)                      |
| `jobs.json`                         | Transfer history                                                               |
| `loaded-images.json`                | References this app loaded into Docker                                         |
| `blob-cache/sha256/*`               | Verified layer cache, pruned least-recently-used first to the configured size  |

Writes are atomic (temp file + rename) with mode `0600`.
