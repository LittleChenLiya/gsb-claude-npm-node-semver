'use strict'

// Explain WHY a set of ranges do or do not intersect.
//
// Each Range is a union of "simple" ranges (comparator AND-sets split on
// "||").  The intersection of the given ranges is the union, over the
// cartesian product of their simple ranges, of the intersection of each
// combination.  Every combination is decided analytically from its
// normalized comparators and the version ordering, never by sampling
// candidate versions:
//
// - Merge the comparators of a combination into a set EQ of "="
//   comparators, the highest lower bound GT (">"/">=") and the lowest
//   upper bound LT ("<"/"<=").  ANY comparators ("*") constrain nothing,
//   and the null-set comparator "<0.0.0-0" makes the combination empty.
// - More than one distinct EQ version, GT ordered above LT (or equal
//   without both ends inclusive), or an EQ version failing GT/LT, means
//   the combination is empty, and the involved comparators are a
//   genuinely unsatisfiable conflict set.
// - Otherwise the interval minimum is derived from GT: the bound version
//   itself for ">=", "0.0.0-0" when unbounded below, and for ">" the
//   successor in the version ordering (append ".0" to a prerelease,
//   otherwise bump the lowest non-MAX_SAFE_INTEGER component and use
//   "-0").  If that minimum violates LT, no version lies between the
//   bounds.
// - With includePrerelease off, the default prerelease exclusion is
//   applied per original range: a prerelease version only counts when
//   every range admits its [major, minor, patch] tuple through a
//   prerelease comparator in the chosen simple range.  Merging bounds
//   alone is not enough, so when the interval minimum is an excluded
//   prerelease, the witness is its tuple's release version, the lowest
//   unconditionally admissible version above it.
// - Every derived witness is re-checked against each original Range via
//   Range.test().
//
// When no combination yields a version, the per-combination conflicting
// comparator sets (each tagged with its source range index) explain why.

const Range = require('../classes/range.js')
const Comparator = require('../classes/comparator.js')
const SemVer = require('../classes/semver.js')
const compare = require('../functions/compare.js')
const { MAX_SAFE_INTEGER } = require('../internal/constants.js')

const { ANY } = Comparator

const NULL_SET = '<0.0.0-0'

/**
 * @typedef {object} ExplainedConflict
 * @property {string} reason One of 'null-set', 'conflicting-bounds',
 *   'conflicting-equalities' or 'prerelease-excluded'.
 * @property {Array<{ index: number, comparator: string }>} comparators
 *   The jointly unsatisfiable comparators, each tagged with the index of
 *   the range it came from.
 */

/**
 * @typedef {object} ExplainedIntersection
 * @property {boolean} intersects Whether all ranges share a version.
 * @property {string} [version] When intersecting, the minimal version
 *   satisfying every range (never carries build metadata).
 * @property {ExplainedConflict[]} [conflicts] When not intersecting, the
 *   conflicting comparator combinations behind each empty branch.
 */

/**
 * Explain the intersection of one or more ranges.
 *
 * @param {Array<string|Range>} ranges At least one range.
 * @param {object} [options] Same options as Range (loose, includePrerelease).
 * @returns {ExplainedIntersection}
 */
const explainIntersection = (ranges, options = {}) => {
  if (typeof ranges === 'string' || ranges instanceof Range) {
    ranges = [ranges]
  }
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new TypeError('explainIntersection requires at least one range')
  }
  const parsed = ranges.map((range, index) => {
    try {
      return new Range(range, options)
    } catch (er) {
      throw new TypeError('Invalid range at index ' + index + ': ' + er.message)
    }
  })

  const conflicts = []
  const seenConflicts = new Set()
  let witness = null

  // walk the cartesian product of simple ranges, one AND-set per range
  const walk = (rangeIndex, chosen) => {
    if (rangeIndex === parsed.length) {
      const found = explainCombination(chosen, options, conflicts, seenConflicts)
      if (found && parsed.every(range => range.test(found)) &&
          (!witness || compare(found, witness) < 0)) {
        witness = found
      }
      return
    }
    for (const simple of parsed[rangeIndex].set) {
      chosen.push(simple.map(comparator => ({ comparator, index: rangeIndex })))
      walk(rangeIndex + 1, chosen)
      chosen.pop()
    }
  }
  walk(0, [])

  if (witness) {
    return { intersects: true, version: formatVersion(witness) }
  }
  return { intersects: false, conflicts }
}

// examine one combination of simple ranges; returns a SemVer witness or null
const explainCombination = (chosen, options, conflicts, seenConflicts) => {
  const flat = chosen.flat()
  const includePrerelease = !!options.includePrerelease

  const nullSet = flat.find(({ comparator }) => comparator.value === NULL_SET)
  if (nullSet) {
    addConflict(conflicts, seenConflicts, 'null-set', [nullSet])
    return null
  }

  const eqMap = new Map()
  let gt = null
  let lt = null
  for (const entry of flat) {
    const { comparator } = entry
    if (comparator.semver === ANY) {
      continue
    }
    const op = comparator.operator
    if (op === '>' || op === '>=') {
      gt = higherGT(gt, entry)
    } else if (op === '<' || op === '<=') {
      lt = lowerLT(lt, entry)
    } else {
      eqMap.set(comparator.semver.version, entry)
    }
  }

  const eqs = [...eqMap.values()]
  if (eqs.length > 1) {
    addConflict(conflicts, seenConflicts, 'conflicting-equalities', eqs)
    return null
  }

  if (gt && lt) {
    const order = compare(gt.comparator.semver, lt.comparator.semver)
    if (order > 0 ||
        (order === 0 &&
         (gt.comparator.operator !== '>=' || lt.comparator.operator !== '<='))) {
      addConflict(conflicts, seenConflicts, 'conflicting-bounds', [gt, lt])
      return null
    }
  }

  // tuples each range admits prereleases for, via the chosen simple range
  const admittedTuples = () => {
    let admitted = null
    for (const simple of chosen) {
      const tuples = new Set()
      for (const { comparator } of simple) {
        if (comparator.semver !== ANY && comparator.semver.prerelease.length) {
          tuples.add(tupleKey(comparator.semver))
        }
      }
      admitted = admitted === null ? tuples
        : new Set([...admitted].filter(tuple => tuples.has(tuple)))
    }
    return admitted
  }

  if (eqs.length === 1) {
    const eq = eqs[0]
    const version = eq.comparator.semver
    if (gt && !boundSatisfied(version, gt.comparator)) {
      addConflict(conflicts, seenConflicts, 'conflicting-equalities', [eq, gt])
      return null
    }
    if (lt && !boundSatisfied(version, lt.comparator)) {
      addConflict(conflicts, seenConflicts, 'conflicting-equalities', [eq, lt])
      return null
    }
    if (!includePrerelease && version.prerelease.length &&
        !admittedTuples().has(tupleKey(version))) {
      addConflict(conflicts, seenConflicts, 'prerelease-excluded', relevant(flat))
      return null
    }
    return version
  }

  // minimum of the interval when prereleases are allowed
  const min = intervalMinimum(gt)
  if (min === null) {
    // >MAX.MAX.MAX style bound: no version can follow it
    addConflict(conflicts, seenConflicts, 'conflicting-bounds', relevant(flat))
    return null
  }
  if (lt && !boundSatisfied(min, lt.comparator)) {
    addConflict(conflicts, seenConflicts, 'conflicting-bounds',
      [gt, lt].filter(Boolean))
    return null
  }

  if (includePrerelease || min.prerelease.length === 0) {
    return min
  }

  // default prerelease exclusion, applied per original range: when the
  // interval minimum is a prerelease its tuple must be admitted by every
  // range, otherwise the lowest admissible version above it is the
  // tuple's release version (prereleases of higher tuples sort even
  // higher, so nothing else can come first)
  if (admittedTuples().has(tupleKey(min))) {
    return min
  }
  const release = new SemVer(tupleKey(min))
  if (!lt || boundSatisfied(release, lt.comparator)) {
    return release
  }
  addConflict(conflicts, seenConflicts, 'prerelease-excluded', relevant(flat))
  return null
}

// >=1.2.3 is lower than >1.2.3
const higherGT = (a, b) => {
  if (!a) {
    return b
  }
  const order = compare(a.comparator.semver, b.comparator.semver)
  return order > 0 ? a
    : order < 0 ? b
    : b.comparator.operator === '>' && a.comparator.operator === '>=' ? b
    : a
}

// <=1.2.3 is higher than <1.2.3
const lowerLT = (a, b) => {
  if (!a) {
    return b
  }
  const order = compare(a.comparator.semver, b.comparator.semver)
  return order < 0 ? a
    : order > 0 ? b
    : b.comparator.operator === '<' && a.comparator.operator === '<=' ? b
    : a
}

const boundSatisfied = (version, bound) => {
  const order = compare(version, bound.semver)
  switch (bound.operator) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    /* istanbul ignore next */
    default: return false
  }
}

// the smallest version allowed by the lower bound, prereleases included;
// null when no version can follow the bound
const intervalMinimum = (gt) => {
  if (!gt) {
    return new SemVer('0.0.0-0')
  }
  const { semver, operator } = gt.comparator
  if (operator === '>=') {
    return semver
  }
  return successor(semver)
}

// the next version after v in the version ordering
const successor = (v) => {
  const core = v.major + '.' + v.minor + '.' + v.patch
  if (v.prerelease.length) {
    return new SemVer(core + '-' + [...v.prerelease, 0].join('.'))
  }
  if (v.patch < MAX_SAFE_INTEGER) {
    return new SemVer(v.major + '.' + v.minor + '.' + (v.patch + 1) + '-0')
  }
  if (v.minor < MAX_SAFE_INTEGER) {
    return new SemVer(v.major + '.' + (v.minor + 1) + '.0-0')
  }
  if (v.major < MAX_SAFE_INTEGER) {
    return new SemVer((v.major + 1) + '.0.0-0')
  }
  return null
}

const tupleKey = (v) => v.major + '.' + v.minor + '.' + v.patch

// strip build metadata: it never takes part in precedence
const formatVersion = (v) =>
  v.major + '.' + v.minor + '.' + v.patch +
  (v.prerelease.length ? '-' + v.prerelease.join('.') : '')

const relevant = (flat) =>
  flat.filter(({ comparator }) => comparator.semver !== ANY)

const addConflict = (conflicts, seenConflicts, reason, entries) => {
  const comparators = entries.map(({ comparator, index }) => ({
    index,
    comparator: comparator.value,
  }))
  const key = reason + '|' + comparators
    .map(c => c.index + ':' + c.comparator)
    .sort()
    .join('|')
  if (!seenConflicts.has(key)) {
    seenConflicts.add(key)
    conflicts.push({ reason, comparators })
  }
}

module.exports = explainIntersection
