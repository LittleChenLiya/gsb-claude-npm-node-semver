'use strict'

const Range = require('../classes/range')
const SemVer = require('../classes/semver')

// Hard upper bound on the number of consumers supported. The minimum cover is
// solved with an exact memoized search over one bit per consumer, so the
// problem size is deliberately capped.
const MAX_CONSUMERS = 20

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizeConsumers = (consumers) => {
  if (!Array.isArray(consumers)) {
    throw new TypeError('consumers must be an array of SemVer ranges')
  }
  if (consumers.length > MAX_CONSUMERS) {
    throw new RangeError(
      `min-cover supports at most ${MAX_CONSUMERS} consumers, got ${consumers.length}`
    )
  }
  return consumers.map((consumer, index) => {
    if (isPlainObject(consumer)) {
      if (typeof consumer.range !== 'string') {
        throw new TypeError(`consumer ${index} must have a string range`)
      }
      return {
        name: consumer.name === undefined ? String(index) : consumer.name,
        range: consumer.range,
      }
    }
    if (typeof consumer !== 'string') {
      throw new TypeError(`consumer ${index} must be a SemVer range string`)
    }
    return { name: String(index), range: consumer }
  })
}

// Compress the version list into candidate groups. Versions within a group are
// interchangeable for the given consumers: they satisfy exactly the same set
// of ranges. Groups are compared on SemVer precedence only (build metadata is
// ignored), never on the raw version strings. Within a precedence level the
// earliest occurrence in the input wins, which also keeps the first occurrence
// of exact duplicates and of semver-equal versions (e.g. different build
// metadata).
const buildGroups = (versions, ranges, options) => {
  const groups = new Map()
  versions.forEach((version, firstIndex) => {
    let semver
    try {
      semver = new SemVer(version, options)
    } catch (er) {
      // Unparseable entries in the version list are not candidates.
      return
    }
    let mask = 0
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i].test(semver)) {
        mask |= 1 << i
      }
    }
    // Versions that match no range are useless, as are versions that fail to
    // parse: Range.test returns false for both, so mask stays 0.
    if (mask === 0) {
      return
    }
    if (!groups.has(mask)) {
      groups.set(mask, { version, mask, firstIndex, semver })
    }
  })

  return Array.from(groups.values()).sort((a, b) =>
    // Highest precedence first; ties keep the earliest input occurrence.
    b.semver.compare(a.semver) || a.firstIndex - b.firstIndex
  )
}

// Exact minimum set cover over the compressed groups. With at most
// MAX_CONSUMERS consumers the uncovered set fits in a 32-bit mask, so the
// minimum tail size for every reachable remaining mask is memoized directly:
//   minSize(mask) = min over groups g intersecting mask of
//                   1 + minSize(mask & ~g.mask)
// Groups are sorted by descending representative version, so after the minimum
// size is known the lexicographically largest descending version list is
// rebuilt by always taking the first (highest) group that can still lead to a
// minimum-size completion.
const findMinCover = (groups, totalMask) => {
  const minSize = new Map([[0, 0]])
  const solve = (mask) => {
    if (minSize.has(mask)) {
      return minSize.get(mask)
    }
    let bestSize = Infinity
    for (const group of groups) {
      if ((group.mask & mask) === 0) {
        continue
      }
      const next = mask & ~group.mask
      const tail = solve(next)
      if (tail !== Infinity && tail + 1 < bestSize) {
        bestSize = tail + 1
        // One group covers everything still remaining: optimal tail size.
        if (bestSize === 1) {
          break
        }
      }
    }
    minSize.set(mask, bestSize)
    return bestSize
  }

  if (solve(totalMask) === Infinity) {
    return null
  }

  const cover = []
  let remaining = totalMask
  while (remaining) {
    const needed = minSize.get(remaining)
    for (const group of groups) {
      const next = remaining & ~group.mask
      if (next !== remaining && minSize.get(next) === needed - 1) {
        cover.push(group)
        remaining = next
        break
      }
    }
  }
  return cover
}

const minCover = (consumers, versions, options) => {
  if (!Array.isArray(versions)) {
    throw new TypeError('versions must be an array of SemVer versions')
  }
  const normalized = normalizeConsumers(consumers)

  // Parse every range up front: an invalid range is an overall error.
  const ranges = normalized.map((consumer, index) => {
    try {
      return new Range(consumer.range, options)
    } catch (er) {
      const error = new TypeError(
        `Invalid SemVer Range for consumer ${consumer.name}: ${consumer.range}`
      )
      error.code = 'EINVALIDRANGE'
      error.index = index
      error.cause = er
      throw error
    }
  })

  const totalMask = (1 << normalized.length) - 1
  const groups = buildGroups(versions, ranges, options)

  const uncovered = []
  let coveredMask = 0
  for (const group of groups) {
    coveredMask |= group.mask
  }
  normalized.forEach((consumer, index) => {
    if ((coveredMask & (1 << index)) === 0) {
      uncovered.push({ name: consumer.name, range: consumer.range, index })
    }
  })
  if (uncovered.length) {
    return {
      covered: false,
      versions: [],
      assignments: normalized.map(() => null),
      uncovered: uncovered.map((consumer) => consumer.name),
      uncoveredConsumers: uncovered,
    }
  }

  const cover = findMinCover(groups, totalMask)
  // Assign every consumer the highest-precedence selected version it satisfies.
  const assignments = normalized.map((consumer, index) => {
    const group = cover.find((candidate) => candidate.mask & (1 << index))
    return group.version
  })

  return {
    covered: true,
    versions: cover.map((group) => group.version),
    assignments,
    uncovered: [],
  }
}

minCover.MAX_CONSUMERS = MAX_CONSUMERS

module.exports = minCover
