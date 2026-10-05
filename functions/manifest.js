'use strict'

// A release manifest index.
//
// An index sorts a batch of release versions by semver precedence while
// keeping the independent identity of every full version: two versions that
// differ only in build metadata (e.g. `1.0.0+a` and `1.0.0+b`) have the same
// precedence but are distinct entries.  Build metadata never takes part in
// precedence or range comparison.
//
// Versions are validated as a batch: if any single input is invalid, the
// whole batch is rejected and no index is produced.  Duplicate full versions
// are merged into a single entry that remembers every source position the
// version came from, without losing any of them.
//
// Entries within the same precedence group keep their original input order
// (stable sort), and range queries return every real version identity that
// satisfies the range.

const SemVer = require('../classes/semver')
const Range = require('../classes/range')
const parseOptions = require('../internal/parse-options')

// The full identity of a version, including build metadata.  Build metadata
// is what makes `1.0.0+a` and `1.0.0+b` two distinct identities even though
// they share a precedence.
const identity = (semver) => {
  const build = semver.build.join('.')
  return build ? `${semver.version}+${build}` : semver.version
}

class ManifestEntry {
  constructor (version, source) {
    this.version = version
    this.sources = [source]
  }

  // The original input string this entry was parsed from.
  get raw () {
    return this.version.raw
  }

  // The canonical full identity: normalized core plus build metadata.
  // Build metadata is preserved here (unlike `semver.clean`), so distinct
  // identities such as `1.0.0+a` and `1.0.0+b` stay distinct.
  get full () {
    const build = this.version.build.join('.')
    return build ? `${this.version.version}+${build}` : this.version.version
  }

  toString () {
    return this.full
  }
}

class Manifest {
  constructor (versions, options) {
    options = parseOptions(options)

    if (!Array.isArray(versions)) {
      throw new TypeError('Manifest expects an array of version strings')
    }

    // Batch validation: parse every input first.  If any single item is
    // invalid, reject the whole batch so that no partial index is produced.
    const parsed = versions.map((v, i) => {
      if (v instanceof SemVer) {
        return { semver: v, source: i }
      }
      if (typeof v !== 'string') {
        throw new TypeError(`Invalid version at index ${i}: must be a string`)
      }
      try {
        return { semver: new SemVer(v, options), source: i }
      } catch (er) {
        throw new TypeError(`Invalid version at index ${i}: ${v}`)
      }
    })

    // Merge duplicate full versions into a single entry, keeping every source
    // position without losing any of them.
    const byIdentity = new Map()
    for (const item of parsed) {
      const key = identity(item.semver)
      let entry = byIdentity.get(key)
      if (!entry) {
        entry = new ManifestEntry(item.semver, item.source)
        byIdentity.set(key, entry)
      } else {
        entry.sources.push(item.source)
      }
    }

    // Sort by precedence only (build metadata is ignored).  Tie-break by the
    // first source position so that entries in the same precedence group keep
    // their original input order, regardless of engine sort stability.
    this.entries = [...byIdentity.values()].sort((a, b) => {
      const cmp = a.version.compare(b.version)
      return cmp !== 0 ? cmp : a.sources[0] - b.sources[0]
    })
  }

  // Return every real version identity satisfying all of the supplied ranges.
  // Build metadata is never used for range matching, so `1.0.0+a` matches
  // `1.0.0` exactly the same way `1.0.0+b` does.
  range (ranges, options) {
    const list = Array.isArray(ranges) ? ranges : [ranges]
    const parsedRanges = list.map((r) => {
      if (r instanceof Range) {
        return r
      }
      return new Range(r, options)
    })
    return this.entries.filter((entry) =>
      parsedRanges.every((r) => r.test(entry.version)))
  }

  // Alias for querying a single range.
  satisfies (range, options) {
    return this.range(range, options)
  }

  // The full version identities in precedence order.
  get versions () {
    return this.entries.map((entry) => entry.full)
  }

  get length () {
    return this.entries.length
  }

  [Symbol.iterator] () {
    return this.entries[Symbol.iterator]()
  }
}

const manifest = (versions, options) => new Manifest(versions, options)

module.exports = manifest
module.exports.Manifest = Manifest
module.exports.ManifestEntry = ManifestEntry
module.exports.identity = identity
