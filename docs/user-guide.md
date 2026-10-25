# User guide

## 1. First launch and login

1. **Create a master password.** It must be at least 8 characters, and a strength meter guides you.
   The password encrypts every registry credential on this device. It cannot be recovered.
2. **Later launches** ask for the master password. If you turned on **Settings → Security → Unlock with
   Touch ID / OS keychain**, the app offers that first.
3. **Locking.**
   - Press **Lock** in the sidebar, or ⌘L on macOS / Ctrl+L on Windows and Linux.
   - The app also locks automatically after the idle time set in Settings, and when the computer
     sleeps or the screen locks.
4. **Forgot the password?** Choose **Reset vault** on the login screen. This deletes the saved
   credentials but keeps your registry connections.

## 2. Registries (create, read, update, delete)

**Registries → Add registry**:

1. Pick the type (Generic/Custom, Docker Hub, Harbor, Nexus, Artifactory, ECR, Google, Azure, GHCR or
   GitLab). The form adapts to the type. Click **Setup guide** next to the description for that
   provider's instructions without leaving the form, or see [Registry setup](registries.md).
2. Fill in the name, color, URL, namespace and credentials.
3. **Connection security.**
   - Add a custom CA certificate (PEM) for private PKI.
   - **Skip TLS verification** is for lab registries only.
   - **Plain HTTP** is for local registries such as `localhost:5000`.
4. Click **Test connection**. It shows the result, the auth method (basic or bearer), the latency, and
   whether repositories can be listed.
5. Click **Add registry**.

Each registry card offers:

- **Explore**
- **Edit.** Secret fields show "saved". Type into a field to replace it, or use **Clear saved credentials**.
- **Test**
- **Duplicate**
- **Make default.** The default registry is selected on startup.
- **Delete.** This removes the connection and its credentials from this device only.

To switch registries, use the selector at the top of the sidebar or press **⌘K / Ctrl+K** and type to filter.

**Import docker logins** finds the registries you already signed in to with `docker login`, both in
`~/.docker/config.json` and in its credential helpers (macOS Keychain, Docker Desktop, Windows Credential
Manager, pass / secret service). Pick the ones you want and they are added with their credentials copied
into your vault. Your Docker configuration is not changed.

- Your OS may ask for permission to read the keychain.
- ECR logins can't be imported: docker only keeps a 12-hour token. Add ECR with AWS access keys instead.
- Registries you already added are marked **already added**.

**Import / Export** saves connections to a JSON file. You can include credentials, encrypted with a
passphrase, to move your setup to another machine.

## 3. Explorer

Three panes: **repositories → tags → image details**.

**Repositories pane**

- Filter the list. Press **Enter** to open a repository that isn't listed.
- **Pin** repositories you use often. Pinning is the way to work with registries that don't allow listing
  (`_catalog` disabled), such as Docker Hub without a namespace or restricted Nexus and Artifactory setups.

**Tags pane**

- Each tag shows its digest, size, creation date and platforms. These load only for the rows you can
  see. On Docker Hub they come from Hub's API, which doesn't count against pull limits, and tags that
  share an image are looked up once.

**Details pane**

- **Overview:** entrypoint, cmd, ports, environment and labels.
- **Layers**, **History**, and **Raw:** the index, manifest and config JSON.
- For multi-architecture images, choose the platform from the selector.

**Actions**

| Action                  | What it does                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pull to Docker**      | Downloads the image with the saved credentials and loads it into your local Docker engine. You can add an extra local tag, such as `myapp:dev`.                                                  |
| **Export .tar**         | Saves the image (the selected platform) as a `.tar` file that `docker load` can read.                                                                                                            |
| **Copy to…**            | Copies to another registry, or another repository or tag. For multi-platform images you can copy all platforms.                                                                                  |
| **Retag**               | Publishes the same manifest under a new tag. No data is copied.                                                                                                                                  |
| **Delete** (trash icon) | Deletes the manifest from the registry. Every tag pointing to the same digest is removed too. The registry must allow deletes; for registry:2 that means `REGISTRY_STORAGE_DELETE_ENABLED=true`. |
| Copy pull command       | Copies `docker pull …` to the clipboard                                                                                                                                                          |

**Import .tar** (top right) pushes a `docker save` archive, `.tar.gz`, or OCI layout tarball into the
current registry.

## 4. Local Images

This screen lists the images in your local Docker engine.

- **Push** sends an image to a registry using the credentials saved in the app.
- **Remove** deletes an image. If it's in use, the app offers a forced remove.
- **Load .tar** imports an archive into Docker.
- Turn on **Pulled via Helix-X only** to see just the images this app loaded.

## 5. Transfers

Every pull, export, import, push, copy and load runs in the background and appears here with its
progress.

- **Cancel** stops a running transfer. **Retry** re-runs a failed or cancelled one.
- **Show in folder** is available for finished exports.
- **Clear finished** removes completed entries from the list.

Downloaded layers go into a verified cache, so a second pull of a similar image is faster.

**Flaky networks.** Short outages don't fail a transfer:

- Failed requests are retried automatically with increasing delays, honouring the registry's
  `Retry-After` on rate limits (HTTP 429) and temporary errors (502/503/504).
- An interrupted layer download continues from where it stopped instead of starting over.
- An interrupted upload restarts that layer, refreshing the login token if it expired.
- If a transfer still fails, **Retry** reuses every layer that already finished downloading.

**Notifications.** When the app is in the background, a system notification tells you when a transfer
finishes or fails; click it to open Transfers. The dock or taskbar icon shows overall progress while
transfers run.

## 6. Settings

| Section             | Options                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Security            | Auto-lock timeout, lock on sleep, keychain / Touch ID unlock, change master password, allow deletes, reset vault |
| Docker engine       | Endpoint override (`unix://`, `npipe://`, `tcp://`). Leave empty to auto-detect.                                 |
| Network             | Proxy (system / none / manual with bypass list), trusted CA certificates, request timeout                        |
| Transfers & storage | Default export folder, parallel jobs, parallel layers, layer cache on/off, size limit, clear                     |
| Diagnostics         | Log level, open logs folder, version information                                                                 |

## 7. Preferences

- **Docker image storage.** Shows where images pulled by the app are stored:
  - **Native Linux engine:** `DockerRootDir`, usually `/var/lib/docker`.
  - **Docker Desktop on macOS:** `Docker.raw` inside the Docker Desktop VM disk, default
    `~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` (or wherever _Disk image location_ points).
  - **Docker Desktop on Windows (WSL 2):** `docker_data.vhdx` under `%LOCALAPPDATA%\Docker\wsl\disk\`
    (`ext4.vhdx` on older versions).
  - **OrbStack, Colima, Rancher Desktop:** their VM disk image.
  - The panel also shows the engine, endpoint and context, storage driver, image count and total size,
    with a **Reveal** button for the file.
- **Pulling images.** Default platform (Auto matches your Docker engine) and local tag style
  (`registry.host/repo:tag` or `repo:tag`).
- **Appearance.** Theme, density, language, date and size formats.
- **Behaviour.** Start page, items per page, and confirmation before deleting.

## 8. Help

**Help** in the sidebar, the **Help** menu, or **F1** opens this documentation inside the app: the user
guide, registry setup, troubleshooting and security. It works offline and always matches your installed
version.
