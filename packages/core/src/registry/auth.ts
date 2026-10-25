// Docker Registry v2 authentication: Basic, and the Bearer token flow described at
// https://distribution.github.io/distribution/spec/auth/token/
export interface Challenge {
  scheme: string
  params: Record<string, string>
}

export interface BasicCredentials {
  username: string
  password: string
}

/**
 * Parse a WWW-Authenticate header. Handles multiple challenges and quoted values that contain commas,
 * e.g. `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:a/b:pull,push"`.
 */
export function parseWwwAuthenticate(header: string | null | undefined): Challenge[] {
  if (!header) return []
  const challenges: Challenge[] = []
  let current: Challenge | undefined
  let i = 0
  const n = header.length
  const isTokenChar = (c: string) => /[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(c)
  while (i < n) {
    while (i < n && (header[i] === ' ' || header[i] === ',' || header[i] === '\t')) i++
    const start = i
    while (i < n && isTokenChar(header[i])) i++
    if (i === start) {
      i++
      continue
    }
    const token = header.slice(start, i)
    let j = i
    while (j < n && header[j] === ' ') j++
    if (header[j] === '=' && current) {
      j++
      while (j < n && header[j] === ' ') j++
      let value = ''
      if (header[j] === '"') {
        j++
        while (j < n && header[j] !== '"') {
          if (header[j] === '\\' && j + 1 < n) j++
          value += header[j++]
        }
        j++ // closing quote
      } else {
        const vs = j
        while (j < n && header[j] !== ',' && header[j] !== ' ') j++
        value = header.slice(vs, j)
      }
      current.params[token.toLowerCase()] = value
      i = j
    } else {
      current = { scheme: token.toLowerCase(), params: {} }
      challenges.push(current)
    }
  }
  return challenges
}

export function basicHeader(c: BasicCredentials): string {
  return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`
}

export function repoScope(repo: string, actions: ('pull' | 'push' | 'delete' | '*')[]): string {
  return `repository:${repo}:${actions.join(',')}`
}

export const CATALOG_SCOPE = 'registry:catalog:*'

/** Parse an RFC 5988 Link header and return the rel="next" target. */
export function parseNextLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*(.*)/.exec(part.trim())
    if (m && /rel="?next"?/i.test(m[2])) return m[1]
  }
  return undefined
}
