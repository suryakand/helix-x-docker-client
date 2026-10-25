// Work out where the local Docker engine keeps images on this machine.
//
// Images are always written through the engine (POST /images/load). This module only *reports*
// the location: on native Linux that's DockerRootDir itself, while VM based engines (Docker Desktop on
// macOS/Windows, Colima, OrbStack, Rancher Desktop) keep DockerRootDir inside a VM disk image on the host.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DockerStatus, DockerStorageInfo } from '@helix/shared/types'
import type { EngineInfo } from './engine'

export interface StorageEnv {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  exists: (p: string) => boolean
  read: (p: string) => string
  size: (p: string) => number | undefined
  list: (p: string) => string[]
}

export const defaultStorageEnv = (): StorageEnv => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  size: (p) => {
    try {
      // Sparse disk images: blocks*512 reflects real usage better than the logical size.
      const s = statSync(p)
      return s.blocks ? s.blocks * 512 : s.size
    } catch {
      return undefined
    }
  },
  list: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
})

type Engine =
  'Docker Desktop' | 'Docker Engine' | 'Colima' | 'OrbStack' | 'Rancher Desktop' | 'Podman' | 'Unknown'

export function detectEngine(info: EngineInfo | undefined, endpoint: string): Engine {
  const os = (info?.OperatingSystem ?? '').toLowerCase()
  const name = (info?.Name ?? '').toLowerCase()
  if (
    os.includes('docker desktop') ||
    endpoint.includes('dockerDesktop') ||
    endpoint.includes('/.docker/run/') ||
    endpoint.includes('/.docker/desktop/')
  ) {
    return 'Docker Desktop'
  }
  if (os.includes('orbstack') || endpoint.includes('orbstack')) return 'OrbStack'
  if (name.includes('colima') || endpoint.includes('.colima')) return 'Colima'
  if (os.includes('rancher') || endpoint.includes('/.rd/') || name.includes('rancher'))
    return 'Rancher Desktop'
  if (os.includes('podman') || endpoint.includes('podman')) return 'Podman'
  if (info) return 'Docker Engine'
  return 'Unknown'
}

function readJson(e: StorageEnv, p: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(e.read(p)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Case-insensitive lookup of the first present key. */
function pick(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined
  const lower = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
  for (const k of keys) {
    const v = lower.get(k.toLowerCase())
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function dockerDesktopMacDisk(e: StorageEnv): string[] {
  const groupDir = join(e.home, 'Library', 'Group Containers', 'group.com.docker')
  const settings =
    readJson(e, join(groupDir, 'settings-store.json')) ?? readJson(e, join(groupDir, 'settings.json'))
  const candidates: string[] = []
  const dataFolder = pick(settings, ['DataFolder', 'dataFolder'])
  const diskPath = pick(settings, ['DiskImage', 'diskPath', 'diskImage'])
  if (diskPath) candidates.push(diskPath)
  if (dataFolder) candidates.push(join(dataFolder, 'Docker.raw'), join(dataFolder, 'Docker.qcow2'))
  const def = join(e.home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'vms', '0', 'data')
  candidates.push(join(def, 'Docker.raw'), join(def, 'Docker.qcow2'))
  return candidates
}

function dockerDesktopWindowsDisk(e: StorageEnv): string[] {
  const local = e.env.LOCALAPPDATA ?? join(e.home, 'AppData', 'Local')
  const roaming = e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming')
  const settings =
    readJson(e, join(roaming, 'Docker', 'settings-store.json')) ??
    readJson(e, join(roaming, 'Docker', 'settings.json'))
  const candidates: string[] = []
  const custom = pick(settings, ['CustomWslDistroDir', 'customWslDistroDir', 'DataFolder', 'dataFolder'])
  if (custom)
    candidates.push(
      join(custom, 'docker_data.vhdx'),
      join(custom, 'disk', 'docker_data.vhdx'),
      join(custom, 'ext4.vhdx')
    )
  candidates.push(
    join(local, 'Docker', 'wsl', 'disk', 'docker_data.vhdx'),
    join(local, 'Docker', 'wsl', 'data', 'ext4.vhdx'),
    // Hyper-V backend
    'C:\\ProgramData\\DockerDesktop\\vm-data\\DockerDesktop.vhdx'
  )
  return candidates
}

function vmDiskCandidates(engine: Engine, e: StorageEnv, contextName?: string): string[] {
  switch (engine) {
    case 'Docker Desktop':
      if (e.platform === 'darwin') return dockerDesktopMacDisk(e)
      if (e.platform === 'win32') return dockerDesktopWindowsDisk(e)
      return [join(e.home, '.docker', 'desktop', 'vms', '0', 'data', 'Docker.raw')]
    case 'Colima': {
      const profile = contextName?.replace(/^colima-?/, '') || 'default'
      const lima = join(e.home, '.colima', '_lima', profile === 'default' ? 'colima' : `colima-${profile}`)
      return [join(lima, 'diffdisk'), join(e.home, '.colima', '_lima', '_disks', profile, 'datadisk')]
    }
    case 'OrbStack': {
      const gc = join(e.home, 'Library', 'Group Containers')
      return e
        .list(gc)
        .filter((d) => d.endsWith('.dev.orbstack'))
        .map((d) => join(gc, d, 'data', 'data.img'))
    }
    case 'Rancher Desktop':
      if (e.platform === 'darwin')
        return [join(e.home, 'Library', 'Application Support', 'rancher-desktop', 'lima', '0', 'diffdisk')]
      if (e.platform === 'win32')
        return [join(e.env.LOCALAPPDATA ?? '', 'rancher-desktop', 'distro-data', 'ext4.vhdx')]
      return [join(e.home, '.local', 'share', 'rancher-desktop', 'lima', '0', 'diffdisk')]
    default:
      return []
  }
}

export function buildStorageInfo(
  status: DockerStatus,
  info: EngineInfo | undefined,
  images: { count: number; size: number } | undefined,
  e: StorageEnv = defaultStorageEnv()
): DockerStorageInfo {
  const engine = detectEngine(info, status.endpoint)
  const notes: string[] = []
  const snapshotter = (info?.DriverStatus ?? []).some(
    ([k, v]) => /driver-type/i.test(k) && /snapshotter/i.test(v)
  )
  const isLocalSocket = status.endpoint.startsWith('unix://') || status.endpoint.startsWith('npipe://')
  const nativeLinux =
    e.platform === 'linux' && isLocalSocket && (engine === 'Docker Engine' || engine === 'Podman')

  let vmDiskPath: string | undefined
  let vmDiskExists = false
  if (!nativeLinux) {
    const candidates = vmDiskCandidates(engine, e, status.contextName)
    vmDiskPath = candidates.find((c) => e.exists(c)) ?? candidates[0]
    vmDiskExists = !!vmDiskPath && e.exists(vmDiskPath)
  }

  if (status.state !== 'connected') {
    notes.push(
      'The Docker engine is not reachable. Start Docker to pull images into it; you can still export images to .tar files.'
    )
  }
  if (nativeLinux) {
    notes.push(
      `Images are stored by the Docker daemon under ${info?.DockerRootDir ?? '/var/lib/docker'} (owned by root).`
    )
  } else if (engine !== 'Unknown' && engine !== 'Docker Engine') {
    notes.push(
      `${engine} runs the engine inside a virtual machine. DockerRootDir (${info?.DockerRootDir ?? '/var/lib/docker'}) is inside the VM disk image shown above.`
    )
  } else if (!isLocalSocket) {
    notes.push('The engine is remote (TCP). Images are stored on that host.')
  }
  if (snapshotter)
    notes.push('The containerd image store is enabled; images are stored as OCI content in containerd.')
  notes.push(
    'Helix-X Docker Client never writes into this location directly. It hands images to the engine (like `docker load`), so they appear in `docker images` and Docker Desktop.'
  )

  return {
    status,
    engineName: engine,
    operatingSystem: info?.OperatingSystem,
    dockerRootDir: info?.DockerRootDir,
    storageDriver: snapshotter ? `${info?.Driver ?? 'overlayfs'} (containerd snapshotter)` : info?.Driver,
    containerdSnapshotter: snapshotter,
    vmDiskPath,
    vmDiskExists,
    vmDiskSizeBytes: vmDiskExists && vmDiskPath ? e.size(vmDiskPath) : undefined,
    rootDirOnHost: nativeLinux,
    imagesCount: images?.count ?? info?.Images,
    imagesSizeBytes: images?.size,
    notes
  }
}
