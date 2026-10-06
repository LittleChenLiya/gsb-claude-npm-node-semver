'use strict'

// subtractRange(allowed, blocked, options)
//
// Computes the exact set difference of two ranges: the set of versions that
// satisfy `allowed` but do not satisfy `blocked`.
//
// Both inputs must be ranges that parse to a finite set of comparator
// conjunctions (any valid semver range qualifies: `||` unions, open and
// closed bounds, pins, and prerelease bounds, with prerelease matching
// following the existing `includePrerelease` rules).  The difference is
// computed symbolically on version intervals, never by sampling versions,
// so the result is exact for every possible version, not just the ones
// that happened to be tested.
//
// The result is expressed again as range fragments in the standard
// comparator grammar, so it can be parsed by `new Range()` again.  Each
// non-empty fragment is reported together with its minimum satisfying
// version (a "witness").  Fragments are sorted and de-duplicated, so the
// output is stable for a given pair of inputs.
//
// If some part of the difference cannot be expressed exactly in the range
// grammar, that part is NOT silently widened; instead a diagnostic is
// returned in the `diagnostics` array and the offending part is omitted.
//
// Neither input Range object is mutated; Range instances are only read,
// and re-parsed from their raw string when the options differ.
//
// Return value:
//   {
//     range: '<fragment> || <fragment>' | null,  // null when empty
//     fragments: [{ range, minVersion }, ...],   // minVersion is a witness
//     diagnostics: [{ code, message }, ...],     // inexpressible parts
//   }

const SemVer = require('../classes/semver')
const Range = require('../classes/range')
const Comparator = require('../classes/comparator')
const compare = require('../functions/compare')
const parseOptions = require('../internal/parse-options')
const { MAX_SAFE_INTEGER } = require('../internal/constants')

// the lowest possible version: nothing is strictly below 0.0.0-0
const LOWEST = new SemVer('0.0.0-0')
// the lowest possible release version
const ZERO = new SemVer('0.0.0')

class UnsupportedComparatorError extends Error {
  constructor (comp) {
    super(`unsupported comparator: ${comp && comp.value}`)
    this.code = 'UNSUPPORTED_COMPARATOR'
  }
}

const tupleKey = (v) => `${v.major}.${v.minor}.${v.patch}`

const releaseOf = (v) => new SemVer(`${v.major}.${v.minor}.${v.patch}`)

// The smallest release strictly greater than the release version v, or
// null when no such version exists.  Components are bounded by
// Number.MAX_SAFE_INTEGER (enforced by the SemVer constructor), so when
// the next release would require incrementing past that boundary we must
// not blindly add one and produce an invalid version; we carry into the
// next component instead, and give up (null) at the top of the domain.
const nextRelease = (v) => {
  if (v.patch < MAX_SAFE_INTEGER) {
    return new SemVer(`${v.major}.${v.minor}.${v.patch + 1}`)
  }
  if (v.minor < MAX_SAFE_INTEGER) {
    return new SemVer(`${v.major}.${v.minor + 1}.0`)
  }
  if (v.major < MAX_SAFE_INTEGER) {
    return new SemVer(`${v.major + 1}.0.0`)
  }
  return null
}

// The smallest version strictly greater than v, or null when v is the
// maximum version of the domain.  For a prerelease that is appending a
// `0` identifier (p is a prefix of p.0, and nothing sorts between them);
// for a release it is the lowest prerelease of the next release.  This
// never constructs a component larger than MAX_SAFE_INTEGER.
const successor = (v) => {
  if (v.prerelease.length) {
    return new SemVer(`${v.major}.${v.minor}.${v.patch}-${v.prerelease.join('.')}.0`)
  }
  const next = nextRelease(v)
  return next ? new SemVer(`${next.version}-0`) : null
}

// An interval over the version domain:
// { lo: SemVer|null, loInc: bool, hi: SemVer|null, hiInc: bool }
// null bounds are unbounded.  Emptiness is decided against the discrete
// version domain, not just the endpoints: `>1.2.3 <1.2.4-0` has lo < hi
// yet contains no version at all.
const isEmptyInterval = ({ lo, loInc, hi, hiInc }) => {
  if (lo && hi) {
    const c = compare(lo, hi)
    if (c > 0) {
      return true
    }
    if (c === 0) {
      return !(loInc && hiInc)
    }
    if (!loInc && !hiInc) {
      const next = successor(lo)
      // no version exists strictly between lo and hi
      return next === null || compare(next, hi) >= 0
    }
    return false
  }
  if (!lo && hi) {
    const c = compare(hi, LOWEST)
    return c < 0 || (c === 0 && !hiInc)
  }
  if (lo && !hi) {
    return !loInc && successor(lo) === null
  }
  return false
}

// Collapse a comparator conjunction into a single interval.  Every
// comparator produced by Range parsing is one of '', <, <=, >, >=, all of
// which are simple interval bounds; anything else cannot be modeled and
// raises UnsupportedComparatorError.
const branchInterval = (comparators) => {
  const iv = { lo: null, loInc: true, hi: null, hiInc: true }
  const raiseLo = (v, inc) => {
    if (!iv.lo || compare(v, iv.lo) > 0) {
      iv.lo = v
      iv.loInc = inc
    } else if (compare(v, iv.lo) === 0) {
      iv.loInc = iv.loInc && inc
    }
  }
  const lowerHi = (v, inc) => {
    if (!iv.hi || compare(v, iv.hi) < 0) {
      iv.hi = v
      iv.hiInc = inc
    } else if (compare(v, iv.hi) === 0) {
      iv.hiInc = iv.hiInc && inc
    }
  }
  for (const comp of comparators) {
    if (comp.semver === Comparator.ANY) {
      continue
    }
    const v = comp.semver
    switch (comp.operator) {
      case '':
        raiseLo(v, true)
        lowerHi(v, true)
        break
      case '>=':
        raiseLo(v, true)
        break
      case '>':
        raiseLo(v, false)
        break
      case '<=':
        lowerHi(v, true)
        break
      case '<':
        lowerHi(v, false)
        break
      default:
        throw new UnsupportedComparatorError(comp)
    }
  }
  return iv
}

// The set of 'M.m.p' tuples for which a comparator conjunction explicitly
// allows prereleases (comparators carrying a prerelease of that tuple).
const branchTuples = (comparators) => {
  const tuples = new Set()
  for (const comp of comparators) {
    if (comp.semver !== Comparator.ANY && comp.semver.prerelease.length) {
      tuples.add(tupleKey(comp.semver))
    }
  }
  return tuples
}

// combined bounds of an intersection
const maxLo = (a, aInc, b, bInc) => {
  if (!a) {
    return [b, bInc]
  }
  if (!b) {
    return [a, aInc]
  }
  const c = compare(a, b)
  if (c > 0) {
    return [a, aInc]
  }
  if (c < 0) {
    return [b, bInc]
  }
  return [a, aInc && bInc]
}

const minHi = (a, aInc, b, bInc) => {
  if (!a) {
    return [b, bInc]
  }
  if (!b) {
    return [a, aInc]
  }
  const c = compare(a, b)
  if (c < 0) {
    return [a, aInc]
  }
  if (c > 0) {
    return [b, bInc]
  }
  return [a, aInc && bInc]
}

// p \ j, as 0-2 intervals.  Bounds of the results always reuse existing
// versions with flipped inclusivity, so no new version is ever invented.
const subtractInterval = (p, j) => {
  const [lo, loInc] = maxLo(p.lo, p.loInc, j.lo, j.loInc)
  const [hi, hiInc] = minHi(p.hi, p.hiInc, j.hi, j.hiInc)
  if (isEmptyInterval({ lo, loInc, hi, hiInc })) {
    return [p] // disjoint
  }
  const out = []
  if (j.lo) {
    const left = { lo: p.lo, loInc: p.loInc, hi: j.lo, hiInc: !j.loInc }
    if (!isEmptyInterval(left)) {
      out.push(left)
    }
  }
  if (j.hi) {
    const right = { lo: j.hi, loInc: !j.hiInc, hi: p.hi, hiInc: p.hiInc }
    if (!isEmptyInterval(right)) {
      out.push(right)
    }
  }
  return out
}

const subtractAll = (pieces, blockedIntervals) => {
  let out = pieces
  for (const j of blockedIntervals) {
    const next = []
    for (const p of out) {
      next.push(...subtractInterval(p, j))
    }
    out = next
  }
  return out
}

const isTuplePrerelease = (v, tuple) =>
  v.prerelease.length > 0 && tupleKey(v) === tuple

// Project an interval onto the prerelease lane of one tuple: the set of
// prereleases of `tuple` inside iv, expressed as an interval whose bounds
// are prereleases of `tuple` (or the `<tuple>` release sentinel as an
// exclusive upper bound).  null when the lane is empty.
const projectLane = (iv, tuple) => {
  const tZero = new SemVer(`${tuple}-0`)
  const tRelease = new SemVer(tuple)
  let lo
  let loInc
  if (!iv.lo || compare(iv.lo, tZero) < 0) {
    lo = tZero
    loInc = true
  } else if (isTuplePrerelease(iv.lo, tuple)) {
    lo = iv.lo
    loInc = iv.loInc
  } else {
    return null // lo is at or above the tuple's release
  }
  let hi
  let hiInc
  if (!iv.hi || compare(iv.hi, tRelease) >= 0) {
    hi = tRelease
    hiInc = false
  } else if (isTuplePrerelease(iv.hi, tuple)) {
    hi = iv.hi
    hiInc = iv.hiInc
  } else {
    return null // hi is below the tuple's lowest prerelease
  }
  return { lo, loInc, hi, hiInc }
}

// The smallest release version inside the interval, or null.  Never
// invents an invalid version: nextRelease() returns null at the
// MAX_SAFE_INTEGER boundary, which simply means "no release here".
const smallestRelease = ({ lo, loInc, hi, hiInc }) => {
  let cand
  if (!lo) {
    cand = ZERO
  } else if (lo.prerelease.length === 0) {
    cand = loInc ? lo : nextRelease(lo)
  } else {
    cand = releaseOf(lo)
  }
  // istanbul ignore next: only reachable for an exclusive bound at the
  // maximum version, which isEmptyInterval already filters out
  if (!cand) {
    return null
  }
  if (hi) {
    const c = compare(cand, hi)
    if (c > 0 || (c === 0 && !hiInc)) {
      return null
    }
  }
  return cand
}

// The smallest prerelease of `tuple` inside the interval, or null.
const smallestTuplePrerelease = ({ lo, loInc, hi, hiInc }, tuple) => {
  const tZero = new SemVer(`${tuple}-0`)
  let cand
  // istanbul ignore else: a piece whose lo is at or above the tuple's
  // release while the tuple is among its bounds is empty, and empty
  // pieces are filtered out before this is called
  if (!lo || compare(lo, tZero) < 0) {
    cand = tZero
  } else if (isTuplePrerelease(lo, tuple)) {
    cand = loInc ? lo : successor(lo)
  } else {
    return null
  }
  // istanbul ignore next: the successor of a prerelease always exists
  if (!cand) {
    return null
  }
  if (hi) {
    const c = compare(cand, hi)
    if (c > 0 || (c === 0 && !hiInc)) {
      return null
    }
  }
  return cand
}

const boundsString = (lo, loInc, hi, hiInc) => {
  const parts = []
  if (lo) {
    parts.push(`${loInc ? '>=' : '>'}${lo.version}`)
  }
  if (hi) {
    parts.push(`${hiInc ? '<=' : '<'}${hi.version}`)
  }
  return parts.length ? parts.join(' ') : '*'
}

const subtractRange = (allowed, blocked, options) => {
  options = parseOptions(options)
  const includePrerelease = !!options.includePrerelease

  // Range instances are only read from.  When the options differ from the
  // ones a Range was built with, the constructor re-parses the raw string
  // into a new object, so the inputs are never mutated.
  const allowedRange = new Range(allowed, options)
  const blockedRange = new Range(blocked, options)

  const diagnostics = []
  const fragments = []

  const inexpressible = (message) => {
    diagnostics.push({ code: 'INEXPRESSIBLE', message })
  }

  // Model the blocked range as intervals once.  If any part of it cannot
  // be modeled, the difference cannot be computed exactly at all: report
  // it and return nothing rather than silently widening the result.
  const blockedBranches = []
  for (const branch of blockedRange.set) {
    let interval
    try {
      interval = branchInterval(branch)
    } catch (er) {
      // istanbul ignore else: branchInterval only raises
      // UnsupportedComparatorError
      if (er instanceof UnsupportedComparatorError) {
        inexpressible(
          'blocked range contains a comparator that is not an interval ' +
          `bound (${er.message}); the difference cannot be computed exactly`)
        continue
      }
      // istanbul ignore next: branchInterval only raises
      // UnsupportedComparatorError
      throw er
    }
    if (!isEmptyInterval(interval)) {
      blockedBranches.push({ interval, tuples: branchTuples(branch) })
    }
  }
  if (diagnostics.length) {
    return { range: null, fragments, diagnostics }
  }
  const blockedIntervals = blockedBranches.map(b => b.interval)

  // Defensive check: a fragment is only emitted when it re-parses and its
  // witness provably belongs to the difference.  Anything else is
  // reported as inexpressible instead of being silently widened.
  const emit = (lo, loInc, hi, hiInc, minVersion) => {
    const range = boundsString(lo, loInc, hi, hiInc)
    let ok = false
    try {
      const fragmentRange = new Range(range, options)
      ok = minVersion !== null &&
        fragmentRange.test(minVersion) &&
        allowedRange.test(minVersion) &&
        !blockedRange.test(minVersion)
    } catch (er) {
      // istanbul ignore next: fragments are built from valid versions
      ok = false
    }
    // istanbul ignore next: defensive; holds by construction, and any
    // regression is reported as inexpressible rather than widened
    if (!ok) {
      inexpressible(
        'cannot express a fragment of the difference exactly ' +
        `(candidate: ${range})`)
      return
    }
    fragments.push({ lo, hi, range, minVersion: minVersion.version })
  }

  for (const branch of allowedRange.set) {
    let iv
    try {
      iv = branchInterval(branch)
    } catch (er) {
      // istanbul ignore else: branchInterval only raises
      // UnsupportedComparatorError
      if (er instanceof UnsupportedComparatorError) {
        inexpressible(
          'allowed range contains a comparator that is not an interval ' +
          `bound (${er.message}); that part of the difference is omitted`)
        continue
      }
      // istanbul ignore next: branchInterval only raises
      // UnsupportedComparatorError
      throw er
    }
    if (isEmptyInterval(iv)) {
      continue
    }
    const tuples = branchTuples(branch)

    if (includePrerelease) {
      // With includePrerelease the satisfied set of a branch is exactly
      // its interval, so plain interval subtraction is the whole story.
      for (const p of subtractAll([iv], blockedIntervals)) {
        const minVersion = p.lo
          ? (p.loInc ? p.lo : successor(p.lo))
          : LOWEST
        emit(p.lo, p.loInc, p.hi, p.hiInc, minVersion)
      }
      continue
    }

    // Release lane: releases satisfy a branch purely by interval, so
    // subtract every blocked interval.  Bounds borrowed from the blocked
    // range that carry a prerelease of a tuple the allowed branch never
    // mentions are snapped to that tuple's release (`>1.5.0-beta` becomes
    // `>=1.5.0`, `<=1.5.0-beta` becomes `<1.5.0`): the prereleases thus
    // dropped were never satisfied by the allowed branch anyway, so the
    // satisfied set is unchanged and no spurious prerelease tuple is
    // introduced into the fragment.
    for (const p of subtractAll([iv], blockedIntervals)) {
      let { lo, loInc, hi, hiInc } = p
      if (lo && lo.prerelease.length && !tuples.has(tupleKey(lo))) {
        lo = releaseOf(lo)
        loInc = true
      }
      if (hi && hi.prerelease.length && !tuples.has(tupleKey(hi))) {
        hi = releaseOf(hi)
        hiInc = false
      }
      const piece = { lo, loInc, hi, hiInc }
      const release = smallestRelease(piece)
      if (!release) {
        // No release content.  Any prerelease content of this piece lives
        // on a tuple the allowed branch mentions, and is covered by that
        // tuple's lane below.
        continue
      }
      let minVersion = release
      const emittedTuples = new Set()
      for (const bound of [lo, hi]) {
        if (bound && bound.prerelease.length) {
          emittedTuples.add(tupleKey(bound))
        }
      }
      for (const tuple of emittedTuples) {
        const cand = smallestTuplePrerelease(piece, tuple)
        if (cand && compare(cand, minVersion) < 0) {
          minVersion = cand
        }
      }
      emit(lo, loInc, hi, hiInc, minVersion)
    }

    // Prerelease lanes: without includePrerelease, a prerelease version
    // only satisfies a branch when the branch mentions its tuple.  For
    // each mentioned tuple, subtract only the blocked branches that also
    // mention that tuple; blocked branches that do not mention it cannot
    // remove its prereleases.
    for (const tuple of tuples) {
      const lane = projectLane(iv, tuple)
      if (!lane || isEmptyInterval(lane)) {
        continue
      }
      const laneBlocked = []
      for (const b of blockedBranches) {
        if (b.tuples.has(tuple)) {
          const projected = projectLane(b.interval, tuple)
          if (projected) {
            laneBlocked.push(projected)
          }
        }
      }
      for (const p of subtractAll([lane], laneBlocked)) {
        // lane bounds are always prereleases of the tuple, except the
        // exclusive upper sentinel at the tuple's release
        const minVersion = p.loInc ? p.lo : successor(p.lo)
        emit(p.lo, p.loInc, p.hi, p.hiInc, minVersion)
      }
    }
  }

  // stable output: sort by bounds, de-duplicate identical fragments
  fragments.sort((a, b) => {
    if (!a.lo !== !b.lo) {
      return a.lo ? 1 : -1
    }
    if (a.lo && b.lo) {
      const c = compare(a.lo, b.lo)
      if (c !== 0) {
        return c
      }
    }
    if (!a.hi !== !b.hi) {
      return a.hi ? -1 : 1
    }
    if (a.hi && b.hi) {
      const c = compare(a.hi, b.hi)
      if (c !== 0) {
        return c
      }
    }
    if (a.range < b.range) {
      return -1
    }
    return a.range > b.range ? 1 : 0
  })
  const seen = new Set()
  const unique = fragments.filter(f => {
    if (seen.has(f.range)) {
      return false
    }
    seen.add(f.range)
    return true
  })

  return {
    range: unique.length ? unique.map(f => f.range).join(' || ') : null,
    fragments: unique.map(f => ({ range: f.range, minVersion: f.minVersion })),
    diagnostics,
  }
}

module.exports = subtractRange
