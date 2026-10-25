export const MT = {
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  OCI_LAYER: 'application/vnd.oci.image.layer.v1.tar',
  OCI_LAYER_GZIP: 'application/vnd.oci.image.layer.v1.tar+gzip',
  OCI_LAYER_ZSTD: 'application/vnd.oci.image.layer.v1.tar+zstd',
  DOCKER_LIST: 'application/vnd.docker.distribution.manifest.list.v2+json',
  DOCKER_MANIFEST: 'application/vnd.docker.distribution.manifest.v2+json',
  DOCKER_CONFIG: 'application/vnd.docker.container.image.v1+json',
  DOCKER_LAYER_GZIP: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
  DOCKER_SCHEMA1: 'application/vnd.docker.distribution.manifest.v1+json',
  DOCKER_SCHEMA1_SIGNED: 'application/vnd.docker.distribution.manifest.v1+prettyjws'
} as const

export const MANIFEST_ACCEPT = [MT.OCI_INDEX, MT.DOCKER_LIST, MT.OCI_MANIFEST, MT.DOCKER_MANIFEST].join(', ')

export function isIndexMediaType(mt: string | undefined): boolean {
  return mt === MT.OCI_INDEX || mt === MT.DOCKER_LIST
}

export function isSchema1(mt: string | undefined): boolean {
  return mt === MT.DOCKER_SCHEMA1 || mt === MT.DOCKER_SCHEMA1_SIGNED
}

export interface ManifestDescriptor {
  mediaType: string
  digest: string
  size: number
  platform?: { os: string; architecture: string; variant?: string; 'os.version'?: string }
  annotations?: Record<string, string>
}

export interface ImageManifest {
  schemaVersion: 2
  mediaType?: string
  config: ManifestDescriptor
  layers: ManifestDescriptor[]
  annotations?: Record<string, string>
}

export interface ImageIndex {
  schemaVersion: 2
  mediaType?: string
  manifests: ManifestDescriptor[]
  annotations?: Record<string, string>
}

/** Index entries that are build attestations (provenance / SBOM) rather than runnable images. */
export function isAttestation(d: ManifestDescriptor): boolean {
  return (
    d.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' ||
    (d.platform?.os === 'unknown' && d.platform?.architecture === 'unknown')
  )
}

export function platformString(p?: { os: string; architecture: string; variant?: string }): string {
  if (!p) return 'unknown'
  return [p.os, p.architecture, p.variant].filter(Boolean).join('/')
}

export function parsePlatform(s: string): { os: string; architecture: string; variant?: string } | undefined {
  const [os, architecture, variant] = s.split('/')
  if (!os || !architecture) return undefined
  return variant ? { os, architecture, variant } : { os, architecture }
}

/** Map Node's process.arch / Docker's Arch values to OCI architecture names. */
export function normalizeArch(arch: string): { architecture: string; variant?: string } {
  switch (arch) {
    case 'x64':
    case 'x86_64':
    case 'amd64':
      return { architecture: 'amd64' }
    case 'arm64':
    case 'aarch64':
      return { architecture: 'arm64' }
    case 'arm':
    case 'armv7l':
      return { architecture: 'arm', variant: 'v7' }
    case 'ia32':
    case 'i386':
    case '386':
      return { architecture: '386' }
    default:
      return { architecture: arch }
  }
}

export function platformMatches(
  candidate: { os: string; architecture: string; variant?: string } | undefined,
  wanted: { os: string; architecture: string; variant?: string }
): boolean {
  if (!candidate) return false
  if (candidate.os !== wanted.os || candidate.architecture !== wanted.architecture) return false
  if (wanted.variant && candidate.variant && wanted.variant !== candidate.variant) return false
  return true
}

/** Choose the best manifest of an index for a wanted platform. */
export function selectManifest(
  index: ImageIndex,
  wanted?: { os: string; architecture: string; variant?: string }
): ManifestDescriptor | undefined {
  const runnable = index.manifests.filter((m) => !isAttestation(m))
  if (wanted) {
    const exact = runnable.find(
      (m) => platformMatches(m.platform, wanted) && m.platform?.variant === wanted.variant
    )
    return exact ?? runnable.find((m) => platformMatches(m.platform, wanted))
  }
  return (
    runnable.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64') ??
    runnable[0] ??
    index.manifests[0]
  )
}
