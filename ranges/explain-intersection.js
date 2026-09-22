'use strict'

// Explain the intersection of one or more ranges.
//
// Given ranges R1 .. Rn (each a union of simple comparator sets), the
// intersection is the set of versions v such that every Ri.test(v) is
// true.  This module either produces the minimum such version (a
// "witness"), or explains why no such version exists by reporting
// comparator combinations that are jointly unsatisfiable, tagged with
// the index of the range each comparator came from.
//
// The result is derived analytically from the normalized comparators
// and version ordering, never by guessing and testing versions:
//
// - The intersection of unions is the union over every combination
//   (one OR branch per range) of the conjunction of that branch's
//   comparators.
// - Within a combination, exact (=) comparators pin a single
//   candidate version.  Otherwise the strongest lower bound (highest
//   > or >=) and strongest upper bound (lowest < or <=) determine an
//   interval; if the interval is empty the combination is unsatisfiable.
// - The minimum feasible version of a non-empty interval is always one
//   of a small set of boundary versions derived from the comparators:
//   the lower bound itself, the version immediately after an exclusive
//   lower bound, the release version of any comparator's core, or the
//   lowest prerelease (-0) of any comparator's core.  The last two
//   are needed because the default prerelease exclusion can reject the
//   raw lower boundary, and only prereleases sharing a
//   [major, minor, patch] tuple with an explicit comparator are
//   allowed by a range in that mode.
// - Each candidate is verified against every original Range.test(),
//   which applies the default prerelease exclusion per original range
//   (not to merged bounds), exactly like satisfies().

const Range = require('../classes/range.js')
const Comparator = require('../classes/comparator.js')
const SemVer = require('../classes/semver.js')
const compare = require('../functions/compare.js')
const { MAX_SAFE_INTEGER } = require('../internal/constants.js')

const { ANY } = Comparator

const isNullSet = c => c.value === '<0.0.0-0'
const isAny = c => c.semver === ANY

/**
 * @typedef {object} ExplainIntersectionConflict
 * @property {'null-set'|'equal-mismatch'|'equal-excluded'|'bounds-conflict'|'prerelease-policy'} reason
 * @property {Array<{ range: number, comparator: string }>} comparators
 */

/**
 * @typedef {object} ExplainIntersectionResult
 * @property {boolean} intersects
 * @property {string|null} version minimum version satisfying every range
 * @property {ExplainIntersectionConflict[]} conflicts
 */

/**
 * Explain the intersection of one or more ranges.
 *
 * @param {Array<string|Range>} ranges at least one range
 * @param {object} [options] the usual semver options (loose, includePrerelease)
 * @returns {ExplainIntersectionResult}
 */
const explainIntersection = (ranges, options = {}) => {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new TypeError('explainIntersection requires at least one range')
  }

  const parsed = ranges.map(r => new Range(r, options))

  let witness = null
  const conflicts = []
  for (const combination of combinations(parsed)) {
    const found = searchCombination(combination, parsed, options)
    if (found) {
      if (!witness || compare(found, witness, options) < 0) {
        witness = found
      }
    } else {
      conflicts.push(conflictFor(combination, options))
    }
  }

  if (witness) {
    return { intersects: true, version: witness.format(), conflicts: [] }
  }
  return { intersects: false, version: null, conflicts }
}

// cartesian product of the OR branches of every range, each branch
// tagged with the index of the range it came from
const combinations = (parsed) => {
  let acc = [[]]
  parsed.forEach((range, rangeIndex) => {
    const next = []
    for (const partial of acc) {
      for (const branch of range.set) {
        next.push([...partial, { range: rangeIndex, comparators: branch }])
      }
    }
    acc = next
  })
  return acc
}

// the minimum version satisfying every comparator of the combination
// and every original range, or null if the combination is infeasible
const searchCombination = (combination, parsed, options) => {
  const comps = []
  for (const { comparators } of combination) {
    for (const c of comparators) {
      if (isNullSet(c)) {
        return null
      }
      if (!isAny(c)) {
        comps.push(c)
      }
    }
  }

  const test = (version) => parsed.every(range => range.test(version))

  // exact versions pin the combination to a single candidate
  let eq = null
  for (const c of comps) {
    if (c.operator === '') {
      if (eq && compare(eq, c.semver, options) !== 0) {
        return null
      }
      eq = c.semver
    }
  }
  if (eq) {
    return comps.every(c => c.test(eq)) && test(eq) ? eq : null
  }

  let gt = null
  let lt = null
  for (const c of comps) {
    if (c.operator === '>' || c.operator === '>=') {
      gt = higherGT(gt, c, options)
    } else if (c.operator === '<' || c.operator === '<=') {
      lt = lowerLT(lt, c, options)
    }
  }

  if (gt && lt) {
    const gtlt = compare(gt.semver, lt.semver, options)
    if (gtlt > 0 || (gtlt === 0 && (gt.operator !== '>=' || lt.operator !== '<='))) {
      return null
    }
  }

  let best = null
  for (const candidate of candidates(gt, comps, options)) {
    if (test(candidate) && (!best || compare(candidate, best, options) < 0)) {
      best = candidate
    }
  }
  return best
}

// the boundary versions that can be the minimum of the interval
const candidates = (gt, comps, options) => {
  const list = new Set()
  if (!gt) {
    list.add('0.0.0')
    list.add('0.0.0-0')
  } else if (gt.operator === '>=') {
    list.add(gt.semver.format())
  } else {
    const s = gt.semver
    if (s.prerelease.length) {
      // the immediate successor of an exclusive prerelease bound
      list.add(`${s.major}.${s.minor}.${s.patch}-${[...s.prerelease, 0].join('.')}`)
      list.add(`${s.major}.${s.minor}.${s.patch}`)
    } else {
      const bump = bumpCore(s)
      if (bump) {
        list.add(`${bump}-0`)
        list.add(bump)
      }
    }
  }
  for (const c of comps) {
    const s = c.semver
    if (s.prerelease.length) {
      list.add(`${s.major}.${s.minor}.${s.patch}`)
      list.add(`${s.major}.${s.minor}.${s.patch}-0`)
    }
  }
  const versions = []
  for (const item of list) {
    try {
      versions.push(new SemVer(item, options))
    } catch (er) {
      // out-of-range component (eg > MAX_SAFE_INTEGER), not a candidate
    }
  }
  return versions
}

// the lowest core strictly greater than the given version's core
const bumpCore = (s) => {
  if (s.patch < MAX_SAFE_INTEGER) {
    return `${s.major}.${s.minor}.${s.patch + 1}`
  }
  if (s.minor < MAX_SAFE_INTEGER) {
    return `${s.major}.${s.minor + 1}.0`
  }
  if (s.major < MAX_SAFE_INTEGER) {
    return `${s.major + 1}.0.0`
  }
  return null
}

// describe why a combination is unsatisfiable.  the comparators of one
// combination (one branch per range) are jointly unsatisfiable together
// with the ranges they came from, which is exactly what the reported
// conflict expresses.
const conflictFor = (combination, options) => {
  const comparators = []
  const comps = []
  for (const { range, comparators: branch } of combination) {
    for (const c of branch) {
      if (isAny(c)) {
        continue
      }
      comparators.push({ range, comparator: c.value })
      comps.push(c)
    }
  }

  let reason = 'prerelease-policy'
  if (comps.some(isNullSet)) {
    reason = 'null-set'
  } else {
    let eq = null
    let eqConflict = false
    for (const c of comps) {
      if (c.operator === '') {
        if (eq && compare(eq, c.semver, options) !== 0) {
          eqConflict = true
        }
        eq = c.semver
      }
    }
    if (eqConflict) {
      reason = 'equal-mismatch'
    } else if (eq) {
      reason = comps.every(c => c.test(eq)) ? 'prerelease-policy' : 'equal-excluded'
    } else {
      let gt = null
      let lt = null
      for (const c of comps) {
        if (c.operator === '>' || c.operator === '>=') {
          gt = higherGT(gt, c, options)
        } else if (c.operator === '<' || c.operator === '<=') {
          lt = lowerLT(lt, c, options)
        }
      }
      if (gt && lt) {
        const gtlt = compare(gt.semver, lt.semver, options)
        if (gtlt > 0 ||
            (gtlt === 0 && (gt.operator !== '>=' || lt.operator !== '<='))) {
          reason = 'bounds-conflict'
        }
      }
    }
  }

  return { reason, comparators }
}

// >=1.2.3 is lower than >1.2.3
const higherGT = (a, b, options) => {
  if (!a) {
    return b
  }
  const comp = compare(a.semver, b.semver, options)
  return comp > 0 ? a
    : comp < 0 ? b
    : b.operator === '>' && a.operator === '>=' ? b
    : a
}

// <=1.2.3 is higher than <1.2.3
const lowerLT = (a, b, options) => {
  if (!a) {
    return b
  }
  const comp = compare(a.semver, b.semver, options)
  return comp < 0 ? a
    : comp > 0 ? b
    : b.operator === '<' && a.operator === '<=' ? b
    : a
}

module.exports = explainIntersection
