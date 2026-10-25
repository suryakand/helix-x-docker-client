import { describe, expect, it } from 'vitest'
import { API_SHAPE } from '../src/channels'
import { ipcSchemas } from '../src/schemas'

describe('IPC contract', () => {
  it('has a validation schema for every exposed method and vice versa', () => {
    const exposed = Object.entries(API_SHAPE)
      .flatMap(([ns, ms]) => ms.map((m) => `${ns}.${m}`))
      .sort()
    expect(Object.keys(ipcSchemas).sort()).toEqual(exposed)
  })

  it('rejects malformed input', () => {
    expect(ipcSchemas['explorer.retag'].safeParse(['id', 'repo', 'v1', 'bad tag!']).success).toBe(false)
    expect(ipcSchemas['explorer.retag'].safeParse(['id', 'repo', 'v1', 'v2']).success).toBe(true)
    expect(ipcSchemas['app.openExternal'].safeParse(['not a url']).success).toBe(false)
    expect(ipcSchemas['transfers.start'].safeParse([{ kind: 'rm -rf' }]).success).toBe(false)
  })
})
