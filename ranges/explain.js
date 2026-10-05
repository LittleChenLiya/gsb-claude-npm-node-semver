'use strict'

// Explicit range explainer.
//
// For a version and a range, report for EACH OR branch (comparator set)
// whether that branch accepts or rejects the version, keeping the numeric
// comparator checks and the prerelease admission rule as separate verdicts.
//
// Only the comparator sets that Range actually normalized (`range.set`) are
// consulted, so the explanation always reflects the real parsed range.
// Prereleases are never merely treated as "lower versions": the admission
// rule mirrors Range's own testSet logic (a prerelease version is admitted
// only when includePrerelease is set, or when a comparator in the same set
// carries a prerelease on the same [major, minor, patch] tuple).
//
// The return value of `satisfies()` is untouched; this is a parallel,
// read-only reporting API.

const parseOptions = require('../internal/parse-options')
const Range = require('../classes/range')
const SemVer = require('../classes/semver')
const Comparator = require('../classes/comparator')

const explainSet = (set, version, options, index) => {
  // 1. numeric comparison: every comparator in the set must pass
  const numeric = set.map(comp => ({
    comparator: comp.value,
    pass: comp.test(version),
  }))
  const numericOk = numeric.every(n => n.pass)

  // 2. prerelease admission: decided independently of the numeric result
  const prerelease = {
    relevant: version.prerelease.length > 0,
    admitted: true,
    reason: 'version has no prerelease',
  }
  if (version.prerelease.length > 0) {
    if (options.includePrerelease) {
      prerelease.reason = 'admitted by the includePrerelease option'
    } else {
      const allowed = set.find(comp =>
        comp.semver !== Comparator.ANY &&
        comp.semver.prerelease.length > 0 &&
        comp.semver.major === version.major &&
        comp.semver.minor === version.minor &&
        comp.semver.patch === version.patch)
      if (allowed) {
        prerelease.reason = `admitted by comparator "${allowed.value}" ` +
          'sharing the same [major, minor, patch] tuple'
      } else {
        prerelease.admitted = false
        prerelease.reason = 'rejected: no comparator in this set admits ' +
          'this prerelease tuple and includePrerelease is not set'
      }
    }
  }

  return {
    index,
    comparators: set.map(comp => comp.value),
    numericOk,
    numeric,
    prerelease,
    accepted: numericOk && prerelease.admitted,
  }
}

const explain = (version, range, options) => {
  options = parseOptions(options)

  const report = {
    version: String(version),
    range: String(range),
    // the loose / includePrerelease options this verdict is bound to
    options: {
      loose: !!options.loose,
      includePrerelease: !!options.includePrerelease,
    },
    satisfied: false,
    branches: [],
  }

  let parsedRange
  try {
    parsedRange = new Range(range, options)
  } catch (er) {
    report.error = `invalid range: ${er.message}`
    return report
  }
  // report the normalized range, not just the raw input
  report.range = parsedRange.range

  let semver = version
  if (typeof version === 'string') {
    try {
      semver = new SemVer(version, options)
    } catch (er) {
      report.error = `invalid version: ${er.message}`
      return report
    }
  }
  report.version = semver.version

  // one conclusion per OR branch, branch identity (index) preserved
  report.branches = parsedRange.set.map((set, index) =>
    explainSet(set, semver, options, index))
  report.satisfied = report.branches.some(branch => branch.accepted)
  return report
}

module.exports = explain
