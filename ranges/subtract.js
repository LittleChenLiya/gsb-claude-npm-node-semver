'use strict'

// subtractRange(allowed, blocked, options)
//
// Computes the exact set difference of two ranges: the set of versions
// that satisfy `allowed` and do not satisfy `blocked`.
//
// Both inputs must be ranges with a finite set of comparators (any range
// string or Range object accepted by this library qualifies, including
// `||` unions, open/closed bounds, and prerelease comparators).  The
// `includePrerelease` option is honored exactly the way `satisfies()`
// honors it.
//
// The result is an object:
//
//   {
//     expressible: true,
//     range: '<0.0.0-0',          // canonical difference, re-parseable
//     fragments: [                // one entry per non-empty fragment
//       { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
//     ],
//   }
//
// `range` is the union (`||`) of all fragments and is always parseable by
// `new Range()`.  An empty difference is reported as the null range
// `<0.0.0-0>` with an empty `fragments` list.  `minVersion` is the
// smallest version (a "witness") that satisfies the fragment.
//
// If the difference cannot be written down exactly in range syntax (for
// example a required version would exceed the maximum version length, or
// the disjunctive normal form would need an unreasonable number of
// fragments), the result is
//
//   { expressible: false, range: null, fragments: null, reason: '...' }
//
// and the range is never silently widened.  The input Range objects are
// only read, never mutated.
//
// Method
// ------
// Without `includePrerelease`, `Range#test` gates prerelease versions on
// a comparator in the same simple range mentioning the same
// major.minor.patch tuple.  To make set algebra exact under that rule,
// every simple range S is first decomposed into "class-pure" conjunctions
// whose matched version classes are disjoint:
//
//   - the release class: the non-prerelease versions matching S.  On
//     non-prerelease versions `>=x-y` is `>=x`, `>x-y` is `>=x`,
//     `<=x-y` is `<x`, `<x-y` is `<x`, and `=x-y` matches nothing, so the
//     release class is expressed with prerelease-free comparators only.
//   - one class per prerelease tuple T mentioned by S: the prerelease
//     versions of tuple T matching S, expressed as
//     `S >=T-0 <T`.  The guards confine matches to tuple T, and `>=T-0`
//     keeps the tuple mentioned so the prerelease gate stays open.
//
// With `includePrerelease` there is no gating, so a single class holding
// the comparator conjunction itself is exact.
//
// Classes are disjoint, so the difference can be computed class by class:
// within a class, matching is pure comparator conjunction, and
//
//   A \ (B1 v ... v Bn) = ((A \ B1) \ B2) \ ... \ Bn
//   A \ (b1 & ... & bn) = union over k of A & b1 & ... & b(k-1) & ~bk
//
// where the negation of a comparator is again a comparator (`=v` needs
// the two branches `<v` and `>v`).  Every fragment is a conjunction of
// comparators, i.e. an interval over the totally ordered versions of its
// class, so it is non-empty iff the least version satisfying its
// strongest lower bound satisfies every comparator; that least version is
// computed directly (with safe-integer carry, never producing an invalid
// version by overflowing a component) and reported as the witness.

const Range = require('../classes/range')
const Comparator = require('../classes/comparator')
const SemVer = require('../classes/semver')
const parseOptions = require('../internal/parse-options')
const compare = require('../functions/compare')
const { MAX_SAFE_INTEGER } = require('../internal/constants')

const { ANY } = Comparator

// Safety bound on the number of fragments generated while expanding a
// difference.  Past this we report the difference as inexpressible
// instead of spinning or silently widening it.
const MAX_FRAGMENTS = 1024

const RELEASE = 'release'
const ALL = 'all'
const PRE = 'pre:'

// Internal error meaning "this difference cannot be expressed exactly".
class Inexpressible extends Error {}

const mkComparator = (str, options) => {
  try {
    return new Comparator(str, options)
  } catch (er) {
    /* istanbul ignore next - defensive: built from valid parsed versions */
    throw new Inexpressible(`cannot construct comparator ${JSON.stringify(str)}: ${er.message}`)
  }
}

const mkVersion = (str, options) => {
  try {
    return new SemVer(str, options)
  } catch (er) {
    throw new Inexpressible(`cannot construct version: ${er.message}`)
  }
}

const tupleOf = v => `${v.major}.${v.minor}.${v.patch}`

// Split a simple range (a conjunction of comparators) into class-pure
// conjunctions with disjoint matched-version classes.  See the header
// comment for why this makes the difference exact.
const classParts = (comparators, options) => {
  const comps = comparators.filter(c => c.semver !== ANY)
  if (options.includePrerelease) {
    return [{ classKey: ALL, comparators: comps }]
  }

  const release = []
  const tuples = new Set()
  let releasePossible = true
  for (const c of comps) {
    const sv = c.semver
    if (!sv.prerelease.length) {
      release.push(c)
      continue
    }
    const tuple = tupleOf(sv)
    tuples.add(tuple)
    // how c matches non-prerelease versions, without the prerelease
    switch (c.operator) {
      case '>':
      case '>=':
        release.push(mkComparator(`>=${tuple}`, options))
        break
      case '<':
      case '<=':
        release.push(mkComparator(`<${tuple}`, options))
        break
      /* istanbul ignore next - '=' is the only other operator */
      default:
        // =1.2.3-pre can never match a non-prerelease version
        releasePossible = false
    }
  }

  const parts = []
  if (releasePossible) {
    parts.push({ classKey: RELEASE, comparators: release })
  }
  for (const tuple of tuples) {
    parts.push({
      classKey: PRE + tuple,
      comparators: [
        ...comps,
        mkComparator(`>=${tuple}-0`, options),
        mkComparator(`<${tuple}`, options),
      ],
    })
  }
  return parts
}

// The complement of a single comparator, as a list of conjunction
// branches.  `=v` needs two branches; anything else negates in place.
const negate = (c, options) => {
  const v = c.semver.version
  switch (c.operator) {
    case '>':
      return [[mkComparator(`<=${v}`, options)]]
    case '>=':
      return [[mkComparator(`<${v}`, options)]]
    case '<':
      return [[mkComparator(`>=${v}`, options)]]
    case '<=':
      return [[mkComparator(`>${v}`, options)]]
    /* istanbul ignore next - ANY comparators are filtered out earlier */
    default:
      return [
        [mkComparator(`<${v}`, options)],
        [mkComparator(`>${v}`, options)],
      ]
  }
}

// a \ b for conjunctions a and b, as a list of conjunctions:
// a \ b = union over k of (a & b0 & ... & b(k-1) & ~bk)
const subtractSimple = (a, b, options) => {
  if (!b.length) {
    // b matches the whole version class, so nothing survives
    return []
  }
  const out = []
  const prefix = []
  for (const comp of b) {
    for (const branch of negate(comp, options)) {
      out.push([...a, ...prefix, ...branch])
    }
    prefix.push(comp)
  }
  return out
}

const inClass = (classKey, v) => {
  if (classKey === ALL) {
    return true
  }
  if (classKey === RELEASE) {
    return v.prerelease.length === 0
  }
  return v.prerelease.length > 0 && tupleOf(v) === classKey.slice(PRE.length)
}

// the smallest version of a class
const classFloor = (classKey, options) => {
  if (classKey === ALL) {
    return mkVersion('0.0.0-0', options)
  }
  /* istanbul ignore else - prerelease tuple classes always carry their
     >=T-0 guard as a lower bound, so this is never reached */
  if (classKey === RELEASE) {
    return mkVersion('0.0.0', options)
  }
  /* istanbul ignore next - unreachable, see above */
  return mkVersion(`${classKey.slice(PRE.length)}-0`, options)
}

// The smallest non-prerelease version strictly greater than v, carrying
// overflow into minor/major so no component ever exceeds
// Number.MAX_SAFE_INTEGER.  null if there is no such version.
const nextRelease = (v, options) => {
  /* istanbul ignore if - release-class comparators never have
     prereleases, so v is always a release version here */
  if (v.prerelease.length) {
    // 1.2.3-pre < 1.2.3, and no release version sits between them
    return mkVersion(tupleOf(v), options)
  }
  if (v.patch < MAX_SAFE_INTEGER) {
    return mkVersion(`${v.major}.${v.minor}.${v.patch + 1}`, options)
  }
  if (v.minor < MAX_SAFE_INTEGER) {
    return mkVersion(`${v.major}.${v.minor + 1}.0`, options)
  }
  if (v.major < MAX_SAFE_INTEGER) {
    return mkVersion(`${v.major + 1}.0.0`, options)
  }
  return null
}

const compareTuple = (v, tuple) => {
  const [major, minor, patch] = tuple.split('.').map(Number)
  return v.major - major || v.minor - minor || v.patch - patch
}

// The smallest version of the class that is >= v (or > v when strict),
// or null when the class has no such version.
const boundInClass = (classKey, v, strict, options) => {
  if (classKey === ALL) {
    if (!strict) {
      return v
    }
    if (v.prerelease.length) {
      // appending a 0 identifier is the least prerelease above v
      return mkVersion(`${v.version}.0`, options)
    }
    const next = nextRelease(v, options)
    return next && mkVersion(`${next.version}-0`, options)
  }
  if (classKey === RELEASE) {
    // release-class comparators never have prereleases, so for `>=`
    // the bound version itself is already the least release version
    if (!strict) {
      return v
    }
    return nextRelease(v, options)
  }
  // prerelease versions of a single tuple
  const tuple = classKey.slice(PRE.length)
  const cmp = compareTuple(v, tuple)
  /* istanbul ignore if - the >=T-0 guard keeps the strongest lower
     bound at or above T-0, so its tuple is never below T */
  if (cmp < 0) {
    return mkVersion(`${tuple}-0`, options)
  }
  if (cmp > 0 || !v.prerelease.length) {
    // the class tops out just below its own release version
    return null
  }
  if (!strict) {
    return v
  }
  return mkVersion(`${v.version}.0`, options)
}

// The minimum version of the class satisfying every comparator, or null
// if the conjunction is empty.  A conjunction of comparators is an
// interval over the totally ordered versions of a class, so it is
// non-empty iff the least version allowed by its strongest lower bound
// satisfies every comparator.
const minimum = (classKey, comps, options) => {
  let eq = null
  let lower = null
  for (const c of comps) {
    if (c.operator === '') {
      if (eq && eq.semver.version !== c.semver.version) {
        return null
      }
      eq = c
    } else if (c.operator === '>' || c.operator === '>=') {
      if (!lower ||
        compare(c.semver, lower.semver) > 0 ||
        (compare(c.semver, lower.semver) === 0 && c.operator === '>')) {
        lower = c
      }
    }
  }
  if (eq) {
    const v = eq.semver
    if (!inClass(classKey, v)) {
      return null
    }
    return comps.every(c => c.test(v)) ? v : null
  }
  const candidate = lower
    ? boundInClass(classKey, lower.semver, lower.operator === '>', options)
    : classFloor(classKey, options)
  if (!candidate) {
    return null
  }
  return comps.every(c => c.test(candidate)) ? candidate : null
}

// Reduce a conjunction to an equivalent conjunction of at most two
// comparators, or null if it is empty.  Exact: over the totally ordered
// versions, satisfying every lower (upper) bound is the same as
// satisfying the strongest one, and a conjunction containing `=v` is
// either just `v` or empty.  Keeping pieces normalized is what keeps the
// disjunctive expansion from growing quadratically in size.
const normalizeConjunction = comps => {
  let eq = null
  let lower = null
  let upper = null
  for (const c of comps) {
    if (c.operator === '') {
      if (eq && eq.semver.version !== c.semver.version) {
        return null
      }
      eq = c
    } else if (c.operator === '>' || c.operator === '>=') {
      if (!lower ||
        compare(c.semver, lower.semver) > 0 ||
        (compare(c.semver, lower.semver) === 0 && c.operator === '>')) {
        lower = c
      }
    } else {
      if (!upper ||
        compare(c.semver, upper.semver) < 0 ||
        (compare(c.semver, upper.semver) === 0 && c.operator === '<')) {
        upper = c
      }
    }
  }
  if (eq) {
    return comps.every(c => c.test(eq.semver)) ? [eq] : null
  }
  if (lower && upper) {
    const cmp = compare(lower.semver, upper.semver)
    if (cmp > 0) {
      return null
    }
    if (cmp === 0 && (lower.operator !== '>=' || upper.operator !== '<=')) {
      return null
    }
  }
  const out = []
  if (lower) {
    out.push(lower)
  }
  if (upper && upper !== lower) {
    out.push(upper)
  }
  return out
}

// at equal versions, print lower bounds before upper bounds
const OP_ORDER = { '>': 0, '>=': 1, '': 2, '<=': 3, '<': 4 }

// Reduce a normalized, non-empty conjunction to a canonical, re-parseable
// fragment string plus its minimum satisfying version.  null when empty.
const buildFragment = (classKey, comps, options) => {
  const map = new Map()
  for (const c of comps) {
    map.set(c.value, c)
  }
  const uniq = [...map.values()]

  const min = minimum(classKey, uniq, options)
  if (!min) {
    return null
  }

  const eqs = uniq.filter(c => c.operator === '')
  let kept
  if (eqs.length) {
    // a satisfiable conjunction with an `=` comparator is just that version
    kept = [eqs[0]]
  } else if (classKey === RELEASE || classKey === ALL) {
    // pieces are normalized to their tightest bounds already
    kept = uniq
  } else {
    // prerelease tuple classes keep their guards so the fragment stays
    // confined to its tuple and the tuple stays mentioned for the
    // prerelease gate
    const tuple = classKey.slice(PRE.length)
    kept = [
      ...uniq,
      mkComparator(`>=${tuple}-0`, options),
      mkComparator(`<${tuple}`, options),
    ]
    // the guards may duplicate the tightest bounds
    const keptMap = new Map()
    for (const c of kept) {
      keptMap.set(c.value, c)
    }
    kept = [...keptMap.values()]
  }

  kept.sort((a, b) =>
    compare(a.semver, b.semver) ||
    OP_ORDER[a.operator] - OP_ORDER[b.operator])

  const range = kept.length ? kept.map(c => c.value).join(' ')
    : classKey === ALL ? '*'
    : '>=0.0.0'
  return { range, minVersion: min.version }
}

const subtractRange = (allowed, blocked, options) => {
  options = parseOptions(options)
  const allowedRange = new Range(allowed, options)
  const blockedRange = new Range(blocked, options)

  try {
    const allowedParts = []
    for (const set of allowedRange.set) {
      allowedParts.push(...classParts(set, options))
    }

    const blockedByClass = new Map()
    for (const set of blockedRange.set) {
      for (const part of classParts(set, options)) {
        // a part that matches nothing subtracts nothing
        if (!minimum(part.classKey, part.comparators, options)) {
          continue
        }
        // exact: a conjunction is its tightest lower and upper bounds
        const normalized = normalizeConjunction(part.comparators)
        /* istanbul ignore if - minimum() above already excludes this */
        if (!normalized) {
          continue
        }
        const list = blockedByClass.get(part.classKey) || []
        list.push(normalized)
        blockedByClass.set(part.classKey, list)
      }
    }

    const fragments = []
    for (const part of allowedParts) {
      const first = normalizeConjunction(part.comparators)
      let pieces = first ? [first] : []
      for (const b of blockedByClass.get(part.classKey) || []) {
        const next = []
        for (const p of pieces) {
          for (const q of subtractSimple(p, b, options)) {
            // keep pieces normalized so the expansion stays small; the
            // exact emptiness check happens in buildFragment
            const normalized = normalizeConjunction(q)
            if (normalized) {
              next.push(normalized)
            }
          }
        }
        pieces = next
        if (pieces.length > MAX_FRAGMENTS) {
          throw new Inexpressible(
            `difference requires more than ${MAX_FRAGMENTS} range fragments`)
        }
      }
      for (const p of pieces) {
        const fragment = buildFragment(part.classKey, p, options)
        if (fragment) {
          fragments.push(fragment)
        }
      }
    }

    // dedupe and sort so the output is stable
    const seen = new Set()
    const frags = fragments.filter(f => {
      if (seen.has(f.range)) {
        return false
      }
      seen.add(f.range)
      return true
    })
    // ranges are unique after dedupe, so this is a total order
    frags.sort((a, b) =>
      compare(a.minVersion, b.minVersion) || (a.range < b.range ? -1 : 1))

    return {
      expressible: true,
      range: frags.length ? frags.map(f => f.range).join(' || ') : '<0.0.0-0',
      fragments: frags,
    }
  } catch (er) {
    /* istanbul ignore else - only Inexpressible is thrown above */
    if (er instanceof Inexpressible) {
      return {
        expressible: false,
        range: null,
        fragments: null,
        reason: er.message,
      }
    }
    /* istanbul ignore next */
    throw er
  }
}

module.exports = subtractRange
