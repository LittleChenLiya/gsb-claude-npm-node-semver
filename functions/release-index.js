'use strict'

const SemVer = require('../classes/semver')
const compare = require('./compare')
const satisfies = require('./satisfies')

// Build a release manifest index from a list of version strings.
//
// - Entries are ordered by semver precedence only. Build metadata is
//   never used for ordering, so `1.0.0+a` and `1.0.0+b` share one
//   precedence group while keeping their distinct identities.
// - Ordering is stable: within a single precedence group, entries keep
//   the order in which they appeared in the input manifest.
// - Exact duplicate full versions (same version including build
//   metadata) are merged into one entry that explicitly records every
//   source position, so no source location is lost.
// - If any item is not a valid version, the whole batch is rejected
//   and no index is produced.
const releaseIndex = (versions, options) => {
  if (!Array.isArray(versions)) {
    throw new TypeError('release index input must be an array of version strings')
  }

  // Parse and validate everything up front, so that a single invalid
  // version rejects the entire batch before any index is created.
  const parsed = versions.map((version, source) => {
    let sv
    try {
      sv = new SemVer(version, options)
    } catch (er) {
      throw new TypeError(
        `Invalid version in release manifest at position ${source}: ${version}`
      )
    }
    const precedence = `${sv.major}.${sv.minor}.${sv.patch}` +
      (sv.prerelease.length ? `-${sv.prerelease.join('.')}` : '')
    // sv.version drops build metadata; rebuild the full identity so
    // that distinct builds keep their own entry in the index.
    const identity = precedence +
      (sv.build.length ? `+${sv.build.join('.')}` : '')
    return { sv, version: identity, precedence, source }
  })

  // Sort by precedence alone; the source position tie-break keeps the
  // ordering stable within a precedence group, matching input order.
  const sorted = parsed.slice().sort((a, b) =>
    compare(a.sv, b.sv) || a.source - b.source)

  // Merge exact duplicate full versions, keeping every source position.
  const entries = []
  const byVersion = new Map()
  for (const item of sorted) {
    const existing = byVersion.get(item.version)
    if (existing) {
      existing.sources.push(item.source)
    } else {
      const entry = {
        version: item.version,
        precedence: item.precedence,
        sources: [item.source],
      }
      byVersion.set(item.version, entry)
      entries.push(entry)
    }
  }

  return {
    entries,
    // Range queries return every real version identity (build metadata
    // included) whose precedence satisfies the range. Build metadata is
    // ignored for the comparison itself.
    query: (range, opts) =>
      entries
        .filter((entry) => satisfies(entry.version, range, opts))
        .map((entry) => entry.version),
  }
}

module.exports = releaseIndex
