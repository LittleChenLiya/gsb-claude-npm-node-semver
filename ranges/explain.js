'use strict'

const Comparator = require('../classes/comparator')
const SemVer = require('../classes/semver')
const parseOptions = require('../internal/parse-options')

// Explicit range interpreter.
//
// Unlike satisfies(), which only reports a boolean, explain() walks the
// ACTUAL normalized Range set (the OR branches produced by the Range
// constructor, never the raw range string) and reports, for every
// comparator group (OR branch), two independent verdicts:
//
//   * numeric:    do the normalized comparators accept the version when
//                 compared as full semver values (prerelease identifiers
//                 included)? A prerelease is never treated as a low
//                 version here - the comparator comparison is run as-is.
//   * prerelease: is the version's prerelease admission allowed? This
//                 mirrors the special prerelease gate in Range.test:
//                 a version with a prerelease is only admitted when
//                 includePrerelease is set, or when one of the group's
//                 comparators carries a prerelease for the same
//                 major.minor.patch.
//
// The includePrerelease/loose options bound to the Range are reported
// alongside the verdicts, and each OR branch gets its own conclusion.
// The top-level `satisfied` is identical to range.test(version), so the
// return value of satisfies() is unaffected.
const explain = (version, range, options) => {
  // lazy require to avoid a load-order cycle with classes/range.js,
  // which requires this module from its bottom requires
  const Range = require('../classes/range')
  const r = range instanceof Range ? range : new Range(range, options)
  const opts = r.options || parseOptions(options)

  let v = version
  if (typeof v === 'string') {
    try {
      v = new SemVer(v, opts)
    } catch (er) {
      v = null
    }
  } else if (!(v instanceof SemVer)) {
    // Range.test only accepts strings or SemVer instances; anything else
    // cannot be interpreted.
    v = null
  }

  const report = {
    version: v ? v.version : null,
    range: r.range || '*',
    raw: r.raw,
    options: {
      loose: !!opts.loose,
      includePrerelease: !!opts.includePrerelease,
    },
    satisfied: false,
    reason: 'invalid-version',
    groups: [],
  }

  if (!v) {
    return report
  }

  report.groups = r.set.map((set, i) => {
    const comparators = set.map((c) => ({
      value: c.value,
      operator: c.operator,
      semver: c.semver === Comparator.ANY ? '' : c.semver.version,
      numeric: c.test(v),
    }))

    // Numeric comparison: every comparator must compare against the full
    // semver value (prerelease identifiers included). A prerelease is
    // NOT downgraded to a low version here.
    const numeric = comparators.every(c => c.numeric)

    // Prerelease admission, kept separate from the numeric comparison.
    let prerelease = true
    if (v.prerelease.length && !opts.includePrerelease) {
      prerelease = set.some((c) => {
        if (c.semver === Comparator.ANY) {
          return false
        }
        if (!c.semver.prerelease || !c.semver.prerelease.length) {
          return false
        }
        return c.semver.major === v.major &&
          c.semver.minor === v.minor &&
          c.semver.patch === v.patch
      })
    }

    const satisfied = numeric && prerelease

    return {
      index: i,
      comparators,
      numeric,
      prerelease,
      satisfied,
      rejectedBy: satisfied ? null : (numeric ? 'prerelease' : 'numeric'),
    }
  })

  report.satisfied = report.groups.some(g => g.satisfied)
  report.reason = report.satisfied
    ? null
    : (report.groups.every(g => g.rejectedBy === 'numeric')
      ? 'numeric'
      : 'prerelease')

  return report
}

module.exports = explain
