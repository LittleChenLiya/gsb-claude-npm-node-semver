'use strict'

// An index over many { id, range } pairs that answers "which ids match
// this version?" without testing every range on every query.
//
// Each range is reduced to a conservative bounding interval
// [lower, upper] in semver precedence order (never string order, so
// '10.0.0' sorts after '2.0.0').  If a version falls outside a range's
// interval, Range.prototype.test() can never return true for it, so the
// range is skipped without a full test() call.  Entries are kept sorted
// by their lower bound so a binary search can discard every range whose
// interval starts above the query version; remaining entries are checked
// against their upper bound and only the survivors are tested for real.
//
// Complexity (n = number of indexed ranges, k = number of ranges whose
// bounding interval contains the query version):
//   construction / update: O(n log n)  (one sort by semver precedence)
//   query:                 O(log n + k) plus k Range.test() calls
//   memory:                O(n)
// Updates are atomic: a batch is fully validated (including parsing every
// new range) before anything is applied, so a bad range leaves the index
// untouched.

const SemVer = require('./semver')
const Range = require('./range')
const Comparator = require('./comparator')
const compare = require('../functions/compare')

// combine a lower bound candidate: keep the maximum, exclusive wins ties
const maxLower = (cur, cand, candInclusive) => {
  if (cur === null) {
    return { value: cand, inclusive: candInclusive }
  }
  const c = compare(cand, cur.value)
  if (c > 0) {
    return { value: cand, inclusive: candInclusive }
  }
  if (c === 0 && !candInclusive) {
    return { value: cand, inclusive: false }
  }
  return cur
}

// combine an upper bound candidate: keep the minimum, exclusive wins ties
const minUpper = (cur, cand, candInclusive) => {
  if (cur === null) {
    return { value: cand, inclusive: candInclusive }
  }
  const c = compare(cand, cur.value)
  if (c < 0) {
    return { value: cand, inclusive: candInclusive }
  }
  if (c === 0 && !candInclusive) {
    return { value: cand, inclusive: false }
  }
  return cur
}

// bounding interval of a single AND-ed comparator set
const setBounds = (comparators) => {
  let lower = null
  let upper = null
  for (const comp of comparators) {
    if (comp.semver === Comparator.ANY) {
      continue
    }
    const v = comp.semver
    switch (comp.operator) {
      case '':
        lower = maxLower(lower, v, true)
        upper = minUpper(upper, v, true)
        break
      case '>=':
        lower = maxLower(lower, v, true)
        break
      case '>':
        lower = maxLower(lower, v, false)
        break
      case '<=':
        upper = minUpper(upper, v, true)
        break
      case '<':
        upper = minUpper(upper, v, false)
        break
    }
  }
  return { lower, upper }
}

// conservative bounding interval of a whole (possibly OR-ed) range.
// a version outside it cannot satisfy any comparator set of the range.
const rangeBounds = (range) => {
  let lower = null
  let lowerInclusive = true
  let upper = null
  let upperInclusive = true
  for (const comparators of range.set) {
    const sb = setBounds(comparators)
    if (sb.lower === null) {
      lower = null
      break
    }
    if (lower === null || compare(sb.lower.value, lower) < 0) {
      lower = sb.lower.value
      lowerInclusive = sb.lower.inclusive
    } else if (compare(sb.lower.value, lower) === 0 && sb.lower.inclusive) {
      // any set may match at the boundary, so an inclusive bound wins
      lowerInclusive = true
    }
  }
  for (const comparators of range.set) {
    const sb = setBounds(comparators)
    if (sb.upper === null) {
      upper = null
      break
    }
    if (upper === null || compare(sb.upper.value, upper) > 0) {
      upper = sb.upper.value
      upperInclusive = sb.upper.inclusive
    } else if (compare(sb.upper.value, upper) === 0 && sb.upper.inclusive) {
      upperInclusive = true
    }
  }
  return { lower, lowerInclusive, upper, upperInclusive }
}

// sort by lower bound in semver precedence order; unbounded (-Infinity)
// entries first, and for equal bounds inclusive before exclusive so that
// the lowerBoundPasses predicate is monotone and binary search is valid
const compareEntries = (a, b) => {
  if (a.lower === null) {
    return b.lower === null ? 0 : -1
  }
  if (b.lower === null) {
    return 1
  }
  const c = compare(a.lower, b.lower)
  if (c !== 0) {
    return c
  }
  if (a.lowerInclusive === b.lowerInclusive) {
    return 0
  }
  return a.lowerInclusive ? -1 : 1
}

const lowerBoundPasses = (entry, version) =>
  entry.lower === null ||
  compare(version, entry.lower) > 0 ||
  (entry.lowerInclusive && compare(version, entry.lower) === 0)

const upperBoundPasses = (entry, version) =>
  entry.upper === null ||
  compare(version, entry.upper) < 0 ||
  (entry.upperInclusive && compare(version, entry.upper) === 0)

const normalizeEntry = (entry) => {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('RangeIndex entries must be { id, range, options } objects')
  }
  const { id, range, options } = entry
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('RangeIndex entry id must be a non-empty string: ' + id)
  }
  return { id, range, options }
}

// parse a query version once so bound checks can compare in semver
// precedence order; returns null when no parse is possible
const parseVersion = (version) => {
  if (version instanceof SemVer) {
    return version
  }
  try {
    return new SemVer(version)
  } catch {
    try {
      return new SemVer(version, true)
    } catch {
      return null
    }
  }
}

class RangeIndex {
  constructor (entries) {
    this._entries = new Map()
    // entries sorted by lower bound, rebuilt after every update
    this._sorted = []
    if (entries !== undefined) {
      this.update({ set: entries })
    }
  }

  get size () {
    return this._entries.size
  }

  has (id) {
    return this._entries.has(id)
  }

  ids () {
    return [...this._entries.keys()].sort()
  }

  // Atomically apply a batch of changes:
  //   update({ set: [{ id, range, options }], delete: [id] })
  // An id listed in both `delete` and `set` is replaced.  The whole batch
  // is validated before anything is applied: duplicate ids, or a range
  // that fails to parse, cause a throw and leave the index unchanged.
  update ({ set = [], delete: remove = [] } = {}) {
    const removeIds = new Set()
    for (const id of remove) {
      if (removeIds.has(id)) {
        throw new Error('RangeIndex update: duplicate id in delete list: ' + id)
      }
      removeIds.add(id)
    }

    const seen = new Set()
    const additions = []
    for (const raw of set) {
      const { id, range, options } = normalizeEntry(raw)
      if (seen.has(id)) {
        throw new Error('RangeIndex update: duplicate id in set list: ' + id)
      }
      seen.add(id)
      if (this._entries.has(id) && !removeIds.has(id)) {
        throw new Error('RangeIndex update: duplicate id: ' + id)
      }
      // parse (and bound) now so an invalid range aborts the whole batch
      const parsed = new Range(range, options)
      additions.push({ id, range: parsed, ...rangeBounds(parsed) })
    }

    // everything validated; apply atomically
    for (const id of removeIds) {
      this._entries.delete(id)
    }
    for (const addition of additions) {
      this._entries.set(addition.id, addition)
    }
    this._rebuild()
    return this
  }

  // Return a fresh, sorted array of the ids whose range matches version.
  // The result is a snapshot: later updates never mutate it.
  query (version) {
    const sv = parseVersion(version)
    const results = []
    if (sv === null) {
      // unparseable version: bounds cannot be computed, so fall back to
      // testing every range to preserve exact Range.test() semantics
      for (const entry of this._entries.values()) {
        if (entry.range.test(version)) {
          results.push(entry.id)
        }
      }
    } else {
      const sorted = this._sorted
      // binary search: first entry whose lower bound excludes the version
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (lowerBoundPasses(sorted[mid], sv)) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      for (let i = 0; i < lo; i++) {
        const entry = sorted[i]
        if (upperBoundPasses(entry, sv) && entry.range.test(version)) {
          results.push(entry.id)
        }
      }
    }
    return results.sort()
  }

  _rebuild () {
    this._sorted = [...this._entries.values()].sort(compareEntries)
  }
}

module.exports = RangeIndex
