import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../src/providers'

describe('provider definitions', () => {
  const registriesDoc = readFileSync(join(__dirname, '../../../docs/registries.md'), 'utf8')

  it('every provider links to an existing section of docs/registries.md (in-app Setup guide)', () => {
    for (const p of PROVIDERS) expect(registriesDoc, p.type).toContain(`<a id="${p.docsAnchor}"></a>`)
  })

  it('has unique types', () => {
    expect(new Set(PROVIDERS.map((p) => p.type)).size).toBe(PROVIDERS.length)
  })
})
