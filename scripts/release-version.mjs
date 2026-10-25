#!/usr/bin/env node
// Version helper for the Release workflow (.github/workflows/release.yml); also usable locally.
//
//   node scripts/release-version.mjs current                       → 0.1.0
//   node scripts/release-version.mjs next <patch|minor|major> [v]  → 0.1.1
//   node scripts/release-version.mjs set <version>                 → writes all versioned package.json files
//   node scripts/release-version.mjs changelog-release <v> <date>  → dates the "## Unreleased" CHANGELOG section
//   node scripts/release-version.mjs notes <version>               → prints that version's CHANGELOG section
//
// Set HELIX_RELEASE_ROOT to operate on another checkout (used by the tests).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The app version (used by electron-builder) and the internal packages kept in lockstep with it. */
export const VERSIONED = [
  'apps/desktop/package.json',
  'packages/core/package.json',
  'packages/shared/package.json'
]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function defaultRoot() {
  return process.env.HELIX_RELEASE_ROOT ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
}

export function parse(version) {
  const m = SEMVER.exec(String(version).trim().replace(/^v/, ''))
  if (!m)
    throw new Error(
      `Not a valid version: "${version}" (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE)`
    )
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] }
}

export function format({ major, minor, patch, prerelease }) {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`
}

export function isPrerelease(version) {
  return parse(version).prerelease !== undefined
}

/** Semver bump. A pre-release bumps to its own release for the matching level (0.2.0-beta.1 → patch → 0.2.0). */
export function next(version, level = 'patch') {
  const v = parse(version)
  if (!['patch', 'minor', 'major'].includes(level))
    throw new Error(`Unknown bump level "${level}" (patch, minor or major)`)
  if (v.prerelease) {
    const isMinorOrMajorBase = v.patch === 0
    const isMajorBase = isMinorOrMajorBase && v.minor === 0
    if (
      level === 'patch' ||
      (level === 'minor' && isMinorOrMajorBase) ||
      (level === 'major' && isMajorBase)
    ) {
      return format({ ...v, prerelease: undefined })
    }
  }
  if (level === 'major') return format({ major: v.major + 1, minor: 0, patch: 0 })
  if (level === 'minor') return format({ major: v.major, minor: v.minor + 1, patch: 0 })
  return format({ major: v.major, minor: v.minor, patch: v.patch + 1 })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function current(root = defaultRoot()) {
  return readJson(join(root, VERSIONED[0])).version
}

/** Write `version` into every versioned package.json, keeping key order and 2-space formatting. */
export function setVersion(version, root = defaultRoot()) {
  const clean = format(parse(version))
  for (const rel of VERSIONED) {
    const path = join(root, rel)
    const pkg = readJson(path)
    pkg.version = clean
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  return clean
}

const UNRELEASED = /^## Unreleased[ \t]*\r?\n/m

/** Body of the "## Unreleased" section (empty string when missing or empty). */
export function unreleasedNotes(changelog) {
  const m = UNRELEASED.exec(changelog)
  if (!m) return ''
  const rest = changelog.slice(m.index + m[0].length)
  const end = rest.search(/^## /m)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/**
 * Turn "## Unreleased" into "## <version> — <date>" and start a new empty Unreleased section.
 * Returns false (and changes nothing) when there are no unreleased notes.
 */
export function changelogRelease(version, date, root = defaultRoot()) {
  const path = join(root, 'CHANGELOG.md')
  const text = readFileSync(path, 'utf8')
  if (!unreleasedNotes(text)) return false
  if (hasSection(text, version))
    throw new Error(`CHANGELOG.md already has a section for ${format(parse(version))}`)
  writeFileSync(path, text.replace(UNRELEASED, `## Unreleased\n\n## ${format(parse(version))} — ${date}\n`))
  return true
}

function sectionHeading(version) {
  const v = format(parse(version)).replace(/[.]/g, '\\.')
  return new RegExp(`^## v?${v}(?:\\s.*)?$`, 'm')
}

function hasSection(text, version) {
  return sectionHeading(version).test(text)
}

/** Notes recorded for `version` in CHANGELOG.md ("## 0.1.0 — 2026-10-24" headings). */
export function notesFor(version, root = defaultRoot()) {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const m = sectionHeading(version).exec(text)
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const end = rest.search(/^## /m)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

function main(argv) {
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'current':
      return current()
    case 'next':
      return next(args[1] ?? current(), args[0] ?? 'patch')
    case 'set':
      if (!args[0]) throw new Error('Usage: set <version>')
      return setVersion(args[0])
    case 'is-prerelease':
      return String(isPrerelease(args[0] ?? current()))
    case 'changelog-release':
      if (!args[0] || !args[1]) throw new Error('Usage: changelog-release <version> <YYYY-MM-DD>')
      return changelogRelease(args[0], args[1]) ? 'updated' : 'unchanged'
    case 'notes':
      return notesFor(args[0] ?? current())
    default:
      throw new Error(
        'Usage: release-version.mjs current | next <level> [version] | set <version> | is-prerelease [version] | changelog-release <version> <date> | notes <version>'
      )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = main(process.argv.slice(2))
    if (out !== undefined && out !== '') process.stdout.write(`${out}\n`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
}
