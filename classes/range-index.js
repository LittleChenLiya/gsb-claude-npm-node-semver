'use strict'

// RangeIndex maintains a set of { id, Range } entries and answers
// "which ids match version v?" without testing every range.
//
// Filtering strategy
// ------------------
// Each entry is reduced to a conservative bounding interval [low, high]
// over the total SemVer ordering (NOT the lexicographic ordering of
// version strings, which would order '10.0.0' before '2.0.0'). A bound
// is a { v: SemVer, eps } key where eps in { -1, 0, +1 } disambiguates
// strict vs inclusive bounds at equal versions:
//
//   >=x  ->  low  { x, 0 }      <=x  ->  high { x, 0 }
//   >x   ->  low  { x, +1 }     <x   ->  high { x, -1 }
//   =x   ->  low  { x, 0 } and high { x, 0 }
//
// A comparator set (AND) takes the max of its lows and the min of its
// highs; an entry (OR of sets) takes the min of set lows and the max of
// set highs. Missing bounds are unbounded (null). Because Range.test()
// only accepts a version when every comparator of some set passes, any
// matching version always lies inside the entry's bounding interval, so
// filtering by the interval can never drop a true match. It may keep
// false positives (e.g. prerelease tuples rejected by the prerelease
// gate in Range.test), which are discarded by a real Range.test() call.
//
// Entries are kept in two sorted arrays: byLow ascending (unbounded
// first) and byHigh ascending (unbounded last). A query binary-searches
// both, iterates the SMALLER of { low <= v } and { high >= v }, checks
// the opposite bound per entry, and only calls Range.test() on the
// survivors. It never unconditionally scans every range.
//
// Complexity (n = number of entries, c = candidates after filtering):
//   build / atomic update : O(n log n)   (one re-sort per commit)
//   query                 : O(log n + m + c * T) where m is the size of
//                           the smaller bound side and T is Range.test()
//   memory                : O(n)
//
// Updates are atomic: every range in a batch is parsed and every id
// validated BEFORE any state changes. A bad range or duplicate id
// aborts the whole batch and the index keeps serving the old data.
// query() returns a fresh array each call, so previously returned
// result snapshots never change when the index is updated.

const Range = require('./range')
const SemVer = require('./semver')
const Comparator = require('./comparator')
const compare = require('../functions/compare')

// total order over { v, eps } bound keys, aligned with Comparator.test
const compareKeys = (a, b) => {
  const c = compare(a.v, b.v)
  return c !== 0 ? c : a.eps - b.eps
}

// null low = -infinity, null high = +infinity
const compareLows = (a, b) => {
  if (a === null || b === null) {
    return a === b ? 0 : (a === null ? -1 : 1)
  }
  return compareKeys(a, b)
}

const compareHighs = (a, b) => {
  if (a === null || b === null) {
    return a === b ? 0 : (a === null ? 1 : -1)
  }
  return compareKeys(a, b)
}

// tighter (larger) lower bound wins; null means unbounded
const maxLow = (a, b) => {
  if (a === null || b === null) {
    return a === null ? b : a
  }
  return compareKeys(a, b) >= 0 ? a : b
}

// tighter (smaller) upper bound wins; null means unbounded
const minHigh = (a, b) => {
  if (a === null || b === null) {
    return a === null ? b : a
  }
  return compareKeys(a, b) <= 0 ? a : b
}

// bounding interval of one comparator set (AND of comparators)
const setBounds = (comparators) => {
  let low = null
  let high = null
  for (const comp of comparators) {
    if (comp.semver === Comparator.ANY) {
      continue
    }
    const v = comp.semver
    switch (comp.operator) {
      case '>':
        low = maxLow(low, { v, eps: 1 })
        break
      case '>=':
        low = maxLow(low, { v, eps: 0 })
        break
      case '<':
        high = minHigh(high, { v, eps: -1 })
        break
      case '<=':
        high = minHigh(high, { v, eps: 0 })
        break
      default:
        // '' / '=' : exact version, bounds meet at { v, 0 }
        low = maxLow(low, { v, eps: 0 })
        high = minHigh(high, { v, eps: 0 })
    }
  }
  return { low, high }
}

// bounding interval of a whole range (OR of sets)
const rangeBounds = (range) => {
  // undefined = no set seen yet, null = unbounded
  let low
  let high
  for (const comparators of range.set) {
    const b = setBounds(comparators)
    if (low !== null) {
      if (b.low === null) {
        low = null
      } else if (low === undefined || compareKeys(b.low, low) < 0) {
        low = b.low
      }
    }
    if (high !== null) {
      if (b.high === null) {
        high = null
      } else if (high === undefined || compareKeys(b.high, high) > 0) {
        high = b.high
      }
    }
  }
  return {
    low: low === undefined ? null : low,
    high: high === undefined ? null : high,
  }
}

const sortIds = (ids) => ids.sort((a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : (sa > sb ? 1 : 0)
})

const isValidId = id =>
  (typeof id === 'string' && id.length > 0) ||
  (typeof id === 'number' && Number.isFinite(id))

// normalize { id, range, options } | [id, range] | [id, range, options]
const normalizeEntry = (entry) => {
  if (Array.isArray(entry)) {
    const [id, range, options] = entry
    return { id, range, options }
  }
  if (entry && typeof entry === 'object') {
    return { id: entry.id, range: entry.range, options: entry.options, delete: entry.delete }
  }
  throw new TypeError('Invalid RangeIndex entry: ' + entry)
}

const normalizeEntries = (entries) => {
  if (entries instanceof Map) {
    return [...entries.entries()].map(([id, value]) => {
      if (value && typeof value === 'object' && !(value instanceof Range) &&
        !Array.isArray(value) && 'range' in value) {
        return { id, range: value.range, options: value.options, delete: value.delete }
      }
      return { id, range: value, options: undefined, delete: value === null }
    })
  }
  if (entries && typeof entries[Symbol.iterator] === 'function') {
    return [...entries].map(normalizeEntry)
  }
  throw new TypeError('RangeIndex entries must be an iterable or a Map')
}

class RangeIndex {
  constructor (entries, options) {
    this.options = options || {}
    // insertion-ordered id -> { id, range, low, high }
    this._entries = new Map()
    this._byLow = []
    this._byHigh = []
    if (entries !== undefined) {
      this.replaceAll(entries)
    }
  }

  get size () {
    return this._entries.size
  }

  has (id) {
    return this._entries.has(id)
  }

  get (id) {
    const entry = this._entries.get(id)
    return entry && entry.range
  }

  ids () {
    return [...this._entries.keys()]
  }

  // build one indexed entry; throws on invalid id, duplicate id, or
  // invalid range. Pure: does not touch index state.
  _makeEntry (id, range, options, seen) {
    if (!isValidId(id)) {
      throw new TypeError('Invalid RangeIndex id: ' + id)
    }
    if (seen ? seen.has(id) : this._entries.has(id)) {
      throw new TypeError('Duplicate RangeIndex id: ' + id)
    }
    const rangeObj = range instanceof Range
      ? range
      : new Range(range, options || this.options)
    const { low, high } = rangeBounds(rangeObj)
    return { id, range: rangeObj, low, high }
  }

  // re-sort the candidate-filter arrays from the current entry map
  _rebuild () {
    const all = [...this._entries.values()]
    this._byLow = all.slice().sort((a, b) => compareLows(a.low, b.low))
    this._byHigh = all.slice().sort((a, b) => compareHighs(a.high, b.high))
  }

  add (id, range, options) {
    const entry = this._makeEntry(id, range, options)
    this._entries.set(id, entry)
    this._rebuild()
    return this
  }

  delete (id) {
    const removed = this._entries.delete(id)
    if (removed) {
      this._rebuild()
    }
    return removed
  }

  // Atomically apply a batch of operations. Each op is
  // { id, range, options } / [id, range, options] to add or replace,
  // or { id, delete: true } / [id] with undefined range to remove.
  // A delete followed by a set of the same id in one batch replaces
  // that id; setting the same id twice is a duplicate and rejects the
  // whole batch. Any invalid range, invalid id, or duplicate id aborts
  // the entire update: the index is left untouched.
  update (ops) {
    const list = normalizeEntries(ops)
    const batchState = new Map() // id -> 'deleted' | 'set'
    const parsed = list.map((op) => {
      const del = op.delete === true || op.range === undefined || op.range === null
      if (!isValidId(op.id)) {
        throw new TypeError('Invalid RangeIndex id: ' + op.id)
      }
      const state = batchState.get(op.id)
      if (del) {
        batchState.set(op.id, 'deleted')
        return { id: op.id, entry: null }
      }
      if (state === 'set') {
        throw new TypeError('Duplicate RangeIndex id in update batch: ' + op.id)
      }
      batchState.set(op.id, 'set')
      const rangeObj = op.range instanceof Range
        ? op.range
        : new Range(op.range, op.options || this.options)
      const { low, high } = rangeBounds(rangeObj)
      return { id: op.id, entry: { id: op.id, range: rangeObj, low, high } }
    })

    // validation passed; commit
    for (const { id, entry } of parsed) {
      if (entry === null) {
        this._entries.delete(id)
      } else {
        this._entries.set(id, entry)
      }
    }
    this._rebuild()
    return this
  }

  // Atomically swap the whole contents of the index. Throws (leaving
  // the index untouched) on any invalid range or duplicate id.
  replaceAll (entries) {
    const list = normalizeEntries(entries)
    const seen = new Set()
    const next = new Map()
    for (const { id, range, options } of list) {
      if (range === undefined || range === null) {
        throw new TypeError('Missing range for RangeIndex id: ' + id)
      }
      const entry = this._makeEntry(id, range, options, seen)
      seen.add(id)
      next.set(id, entry)
    }
    this._entries = next
    this._rebuild()
    return this
  }

  // Return a fresh sorted array of ids whose range matches version.
  // The result is a snapshot: later updates never mutate it.
  query (version) {
    if (!version) {
      return []
    }
    let ver = version
    if (typeof ver === 'string') {
      try {
        ver = new SemVer(ver, this.options)
      } catch (er) {
        return []
      }
    }
    if (!(ver instanceof SemVer)) {
      return []
    }

    const key = { v: ver, eps: 0 }

    // entries with low <= key: prefix of byLow
    let lo = 0
    let hi = this._byLow.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareLows(this._byLow[mid].low, key) <= 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    const lowCount = lo

    // entries with high >= key: suffix of byHigh
    lo = 0
    hi = this._byHigh.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareHighs(this._byHigh[mid].high, key) < 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    const highStart = lo
    const highCount = this._byHigh.length - highStart

    const hits = []
    if (lowCount <= highCount) {
      for (let i = 0; i < lowCount; i++) {
        const entry = this._byLow[i]
        if (entry.high === null || compareKeys(entry.high, key) >= 0) {
          if (entry.range.test(ver)) {
            hits.push(entry.id)
          }
        }
      }
    } else {
      for (let i = highStart; i < this._byHigh.length; i++) {
        const entry = this._byHigh[i]
        if (entry.low === null || compareKeys(entry.low, key) <= 0) {
          if (entry.range.test(ver)) {
            hits.push(entry.id)
          }
        }
      }
    }
    return sortIds(hits)
  }
}

module.exports = RangeIndex
