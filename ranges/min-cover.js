'use strict'

const SemVer = require('../classes/semver')
const Range = require('../classes/range')
const satisfies = require('../functions/satisfies')

// The exact search is exponential in the number of consumers in the
// worst case, so the number of consumer ranges is bounded.
const MAX_CONSUMERS = 20

// Find the smallest set of versions from `versions` such that every
// consumer range in `ranges` is satisfied by at least one version in
// the set.  All matching goes through `satisfies`; ranges are never
// compared as strings.
//
// Returns an object:
// {
//   versions,     // chosen versions, sorted in descending order,
//                 // or null when no cover exists
//   assignments,  // assignments[i] is the chosen version covering
//                 // ranges[i], or null when no cover exists
//   uncovered,    // [{ index, range }] consumers with no candidate
//                 // version at all, empty on success
// }
//
// When several minimal sets have the same size, the one whose
// descending version list is lexicographically largest wins.
// Equivalent versions (equal ignoring build metadata) keep the first
// input occurrence.  Neither input array is modified.
const minCover = (versions, ranges, options) => {
  if (!Array.isArray(versions)) {
    throw new TypeError('versions must be an array of version strings')
  }
  if (!Array.isArray(ranges)) {
    throw new TypeError('ranges must be an array of range strings')
  }
  if (ranges.length > MAX_CONSUMERS) {
    throw new RangeError(
      `minCover supports at most ${MAX_CONSUMERS} consumer ranges, got ${ranges.length}`)
  }

  // Parse and validate every range up front.  A single invalid range
  // fails the whole call.
  const rangeObjs = ranges.map((range, i) => {
    try {
      return new Range(range, options)
    } catch (er) {
      throw new TypeError(`invalid range at index ${i}: ${range}`)
    }
  })

  if (ranges.length === 0) {
    return { versions: [], assignments: [], uncovered: [] }
  }

  // Parse versions, dropping equivalent duplicates (equal ignoring
  // build metadata) and keeping the first input occurrence.
  const seen = new Set()
  const parsed = []
  for (let i = 0; i < versions.length; i++) {
    let sv
    try {
      sv = new SemVer(versions[i], options)
    } catch (er) {
      throw new TypeError(`invalid version at index ${i}: ${versions[i]}`)
    }
    if (seen.has(sv.version)) {
      continue
    }
    seen.add(sv.version)
    parsed.push({ sv, raw: versions[i], mask: 0 })
  }

  // Coverage bitmask per version, always matched via satisfies.
  const full = (1 << ranges.length) - 1
  const coveredAny = new Array(ranges.length).fill(false)
  for (const p of parsed) {
    for (let i = 0; i < rangeObjs.length; i++) {
      if (satisfies(p.sv, rangeObjs[i], options)) {
        p.mask |= (1 << i)
        coveredAny[i] = true
      }
    }
  }

  const uncovered = []
  for (let i = 0; i < ranges.length; i++) {
    if (!coveredAny[i]) {
      uncovered.push({ index: i, range: ranges[i] })
    }
  }
  if (uncovered.length > 0) {
    return { versions: null, assignments: null, uncovered }
  }

  // Compress candidates that cover exactly the same set of consumers
  // to a single representative.  Only the highest version of such an
  // equivalence class can be part of the preferred answer, since
  // swapping a lower one for it keeps the set size and only grows the
  // descending version list.
  const byMask = new Map()
  for (const p of parsed) {
    if (p.mask === 0) {
      continue
    }
    const prev = byMask.get(p.mask)
    if (!prev || prev.sv.compare(p.sv) < 0) {
      byMask.set(p.mask, p)
    }
  }
  const candidates = [...byMask.values()]
    .sort((a, b) => b.sv.compare(a.sv))

  // Exact search for the smallest cover.  Combinations are enumerated
  // in lexicographic index order over candidates sorted by descending
  // version, so the first cover found of a given size is the one with
  // the lexicographically largest descending version list.
  const count = candidates.length
  const suffixOr = new Array(count + 1).fill(0)
  for (let i = count - 1; i >= 0; i--) {
    suffixOr[i] = suffixOr[i + 1] | candidates[i].mask
  }

  let best = null
  const maxSize = Math.min(count, ranges.length)
  for (let size = 1; size <= maxSize && !best; size++) {
    const chosen = []
    const walk = (start, union) => {
      if (chosen.length === size) {
        if (union === full) {
          best = chosen.slice()
        }
        return
      }
      for (let i = start; i < count; i++) {
        // Remaining candidates can no longer complete the cover.
        if ((union | suffixOr[i]) !== full) {
          break
        }
        chosen.push(i)
        walk(i + 1, union | candidates[i].mask)
        chosen.pop()
        if (best) {
          return
        }
      }
    }
    walk(0, 0)
  }

  const chosenVersions = best.map(i => candidates[i])
  const resultVersions = chosenVersions.map(c => c.raw)
  // Each consumer is assigned the highest chosen version that
  // satisfies its range.
  const assignments = rangeObjs.map((rangeObj, i) => {
    const bit = 1 << i
    const hit = chosenVersions.find(c => (c.mask & bit) !== 0)
    return hit.raw
  })
  return { versions: resultVersions, assignments, uncovered: [] }
}

module.exports = minCover
