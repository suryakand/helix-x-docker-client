# Security

## Credential vault

```
master password ──Argon2id(m=64 MiB, t=3, p=1, 16-byte salt)──▶ KEK (256-bit)
KEK ──AES-256-GCM (AAD "data-key")──▶ wraps a random 256-bit Data Key
Data Key ──AES-256-GCM (AAD "secrets")──▶ encrypts the JSON map {registryId: {field: value}}
```

- `vault.json` is written atomically with mode `0600`. Each encryption uses a fresh 96-bit IV. GCM
  authentication tags detect any change to the file.
- Changing the master password only re-wraps the Data Key.
- **Wrong passwords.** Each one costs an Argon2 computation. From the third failure, the app adds an
  exponential delay: 2 s, 4 s, 8 s … up to 5 min.
- **Locking.** Locking zeroes the in-memory key and clears cached registry clients, including their
  bearer tokens. Auto-lock triggers on system idle (configurable), sleep and screen lock.
- **OS keychain unlock (optional).** The Data Key is also stored encrypted with Electron `safeStorage`:
  - **macOS:** Keychain. Touch ID is prompted when available.
  - **Windows:** DPAPI.
  - **Linux:** libsecret / kwallet. The option is turned off when Electron would fall back to its built-in `basic_text` key.
- **Forgotten password.** There is no recovery. _Reset vault_ deletes the stored secrets but keeps the
  registry connections.
- **Backups.** Exported connections contain no secrets unless you choose to include them. Included
  secrets are encrypted with a separate passphrase using the same Argon2id + AES-GCM scheme.

## What the renderer can see

The renderer never receives secret values after they are saved. `registries.list` returns
`credentialHints`: the username or key ID in clear, and `"saved"` for secret fields. The form sends only
the fields you actually edit. Missing keys keep their stored value, and an empty string clears it.

**Importing `docker login` credentials** only reads docker's configuration and credential helpers, and
only when you ask for it. The scan sends the renderer server names, usernames and sources, never
secrets. Secrets are re-read in the main process and written straight into the vault. Helper names from
`config.json` are validated (`[\w.-]+`) and the helper is run without a shell.

## Electron hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- Strict Content-Security-Policy in production: `script-src 'self'`, no remote connections.
- **IPC.** Only the methods in `channels.ts` exist. Every argument is validated with zod, the sender's
  frame URL is checked, and every method except the login and appearance ones requires an unlocked vault.
- **Navigation.** New windows, navigation and `<webview>` are blocked. External links open in the
  browser, and only `https://` links are allowed.
- All permission requests (camera, notifications, …) are denied.
- `openPath` only opens folders, never files.
- A single-instance lock prevents concurrent writers.

## Network

- TLS verification is on by default. Per registry you can add a CA file, skip verification, or use plain
  HTTP. The UI flags the last two in red. Global CA files can be added under Settings → Network.
- Pagination cursors from the renderer or from `Link` headers must stay on the registry's origin under
  `/v2/`, so tokens can't be sent elsewhere.
- Cross-origin redirects (such as blob downloads from S3 or a CDN) drop the `Authorization` header, as
  the Fetch standard requires.
- `Basic …` and `Bearer …` values are redacted from log files.

## Images

- Blobs are verified against their sha256 digest before they enter the cache or an archive.
- Tar extraction rejects absolute paths, `..` segments and links.
- Pull to Docker uses the documented Engine API (`/images/load`). Nothing writes into Docker's data
  directory.

## Reporting a vulnerability

Please report security problems privately to the maintainers. Do not open public issues for them.
