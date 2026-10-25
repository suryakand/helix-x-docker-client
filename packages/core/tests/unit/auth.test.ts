import { describe, expect, it } from 'vitest'
import { parseNextLink, parseWwwAuthenticate } from '../../src/registry/auth'

describe('parseWwwAuthenticate', () => {
  it('parses a Docker Hub bearer challenge with commas inside quotes', () => {
    const [c] = parseWwwAuthenticate(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull,push"'
    )
    expect(c.scheme).toBe('bearer')
    expect(c.params).toEqual({
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:library/nginx:pull,push'
    })
  })

  it('parses basic challenges and multiple challenges', () => {
    const cs = parseWwwAuthenticate('Basic realm="Registry Realm", Bearer realm="https://x/token",service=x')
    expect(cs.map((c) => c.scheme)).toEqual(['basic', 'bearer'])
    expect(cs[0].params.realm).toBe('Registry Realm')
    expect(cs[1].params.service).toBe('x')
  })

  it('handles escaped quotes and empty input', () => {
    expect(parseWwwAuthenticate('Bearer realm="a\\"b"')[0].params.realm).toBe('a"b')
    expect(parseWwwAuthenticate(undefined)).toEqual([])
  })
})

describe('parseNextLink', () => {
  it('extracts rel="next"', () => {
    expect(parseNextLink('</v2/_catalog?last=b&n=2>; rel="next"')).toBe('/v2/_catalog?last=b&n=2')
    expect(parseNextLink('<https://a/x>; rel="prev", <https://a/y>; rel=next')).toBe('https://a/y')
    expect(parseNextLink(null)).toBeUndefined()
  })
})
