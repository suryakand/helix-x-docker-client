import { describe, expect, it } from 'vitest'
import { buildStorageInfo, type StorageEnv } from '../../src/docker/storage'
import type { DockerStatus } from '@helix/shared/types'

const connected = (endpoint: string): DockerStatus => ({
  state: 'connected',
  endpoint,
  endpointSource: 'context',
  version: '29.0.0'
})

function env(
  platform: NodeJS.Platform,
  files: Record<string, string>,
  extra: Partial<StorageEnv> = {}
): StorageEnv {
  return {
    platform,
    home: '/Users/me',
    env: {},
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    size: () => 4096,
    list: () => [],
    ...extra
  }
}

describe('buildStorageInfo', () => {
  it('reports the Docker Desktop VM disk on macOS from settings-store.json', () => {
    const data = '/Volumes/ext/DockerData'
    const files = {
      '/Users/me/Library/Group Containers/group.com.docker/settings-store.json': JSON.stringify({
        DataFolder: data
      }),
      [`${data}/Docker.raw`]: ''
    }
    const info = buildStorageInfo(
      connected('unix:///Users/me/.docker/run/docker.sock'),
      { OperatingSystem: 'Docker Desktop', DockerRootDir: '/var/lib/docker', Driver: 'overlay2' },
      { count: 3, size: 100 },
      env('darwin', files)
    )
    expect(info.engineName).toBe('Docker Desktop')
    expect(info.vmDiskPath).toBe(`${data}/Docker.raw`)
    expect(info.vmDiskExists).toBe(true)
    expect(info.rootDirOnHost).toBe(false)
    expect(info.dockerRootDir).toBe('/var/lib/docker')
  })

  it('reports DockerRootDir directly for a native Linux engine', () => {
    const info = buildStorageInfo(
      connected('unix:///var/run/docker.sock'),
      { OperatingSystem: 'Ubuntu 24.04 LTS', DockerRootDir: '/data/docker' },
      undefined,
      env('linux', {})
    )
    expect(info.engineName).toBe('Docker Engine')
    expect(info.rootDirOnHost).toBe(true)
    expect(info.vmDiskPath).toBeUndefined()
    expect(info.notes.join(' ')).toContain('/data/docker')
  })

  it('uses the WSL2 vhdx on Windows', () => {
    const vhdx = 'C:\\Users\\me\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx'
    const info = buildStorageInfo(
      connected('npipe:////./pipe/dockerDesktopLinuxEngine'),
      { OperatingSystem: 'Docker Desktop', DockerRootDir: '/var/lib/docker' },
      undefined,
      env(
        'win32',
        { [vhdx]: '' },
        { env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }
      )
    )
    expect(info.engineName).toBe('Docker Desktop')
    // Windows paths use backslashes whatever OS runs the code (CI runs this on macOS, Linux and Windows).
    expect(info.vmDiskPath).toBe(vhdx)
    expect(info.vmDiskExists).toBe(true)
  })

  it('detects the containerd image store', () => {
    const info = buildStorageInfo(
      connected('unix:///var/run/docker.sock'),
      {
        OperatingSystem: 'Ubuntu',
        DockerRootDir: '/var/lib/docker',
        Driver: 'overlayfs',
        DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']]
      },
      undefined,
      env('linux', {})
    )
    expect(info.containerdSnapshotter).toBe(true)
  })
})
