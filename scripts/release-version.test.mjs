// node --test scripts/
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  VERSIONED,
  changelogRelease,
  current,
  isPrerelease,
  next,
  notesFor,
  parse,
  setVersion,
  unreleasedNotes
} from './release-version.mjs'

const SCRIPT = fileURLToPath(new URL('./release-version.mjs', import.meta.url))

describe('version math', () => {
  it('bumps patch / minor / major', () => {
    assert.equal(next('0.1.0'), '0.1.1')
    assert.equal(next('0.1.9', 'patch'), '0.1.10')
    assert.equal(next('0.1.3', 'minor'), '0.2.0')
    assert.equal(next('1.4.2', 'major'), '2.0.0')
  })

  it('bumps a pre-release to its release first', () => {
    assert.equal(next('0.2.0-beta.1', 'patch'), '0.2.0')
    assert.equal(next('0.2.0-beta.1', 'minor'), '0.2.0')
    assert.equal(next('0.2.1-rc.1', 'minor'), '0.3.0')
    assert.equal(next('1.0.0-rc.2', 'major'), '1.0.0')
    assert.equal(next('1.2.0-rc.2', 'major'), '2.0.0')
  })

  it('validates versions and levels', () => {
    assert.deepEqual(parse('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: undefined })
    assert.equal(isPrerelease('1.0.0-beta.1'), true)
    assert.equal(isPrerelease('1.0.0'), false)
    assert.throws(() => parse('1.2'), /Not a valid version/)
    assert.throws(() => parse('1.2.3; rm -rf /'), /Not a valid version/)
    assert.throws(() => next('1.2.3', 'huge'), /Unknown bump level/)
  })
})

describe('files', () => {
  let root
  const changelog = `# Changelog

## Unreleased

- Added a thing.
- Fixed another.

## 0.1.0 — 2026-10-24

First release.
`

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'release-version-'))
    for (const rel of VERSIONED) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(
        join(root, rel),
        `${JSON.stringify({ name: rel, version: '0.1.0', private: true }, null, 2)}\n`
      )
    }
    writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('reads and sets the version in every versioned package, keeping formatting', () => {
    assert.equal(current(root), '0.1.0')
    assert.equal(setVersion('v0.1.1', root), '0.1.1')
    for (const rel of VERSIONED) {
      const text = readFileSync(join(root, rel), 'utf8')
      assert.equal(JSON.parse(text).version, '0.1.1')
      assert.match(text, /^\{\n {2}"name": /)
      assert.ok(text.endsWith('}\n'))
      assert.deepEqual(Object.keys(JSON.parse(text)), ['name', 'version', 'private'])
    }
    assert.throws(() => setVersion('nope', root), /Not a valid version/)
  })

  it('dates the Unreleased section and extracts release notes', () => {
    assert.equal(unreleasedNotes(changelog), '- Added a thing.\n- Fixed another.')
    assert.equal(changelogRelease('0.1.1', '2026-11-01', root), true)
    const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    assert.match(text, /## Unreleased\n\n## 0\.1\.1 — 2026-11-01\n\n- Added a thing\./)
    assert.equal(notesFor('0.1.1', root), '- Added a thing.\n- Fixed another.')
    assert.equal(notesFor('0.1.0', root), 'First release.')
    assert.equal(notesFor('9.9.9', root), '')
    // Nothing unreleased any more: a second run changes nothing.
    assert.equal(changelogRelease('0.1.2', '2026-11-02', root), false)
    // Never create a second heading for a version that already has one.
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(
        '## Unreleased\n',
        '## Unreleased\n\n- More.\n'
      )
    )
    assert.throws(() => changelogRelease('0.1.0', '2026-11-03', root), /already has a section for 0\.1\.0/)
  })

  it('works as a CLI', () => {
    const run = (...args) =>
      execFileSync(process.execPath, [SCRIPT, ...args], {
        env: { ...process.env, HELIX_RELEASE_ROOT: root },
        encoding: 'utf8'
      }).trim()
    assert.equal(run('next', 'minor', '0.1.1'), '0.2.0')
    assert.equal(run('set', '0.3.0'), '0.3.0')
    assert.equal(run('current'), '0.3.0')
    assert.equal(run('is-prerelease', '0.3.0-rc.1'), 'true')
    assert.throws(() => run('set', 'bad'), /Not a valid version/)
  })
})
