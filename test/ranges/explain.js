'use strict'

// Local, dependency-free tests for the explicit range explainer.
// Run with: node --test test/ranges/explain.js

const { test } = require('node:test')
const assert = require('node:assert/strict')
const explain = require('../../ranges/explain')
const satisfies = require('../../functions/satisfies')

test('1.2.3-beta vs >=1.0.0 <2.0.0: numeric ok, prerelease rejected', () => {
  const report = explain('1.2.3-beta', '>=1.0.0 <2.0.0')
  assert.equal(report.satisfied, false)
  assert.equal(report.options.loose, false)
  assert.equal(report.options.includePrerelease, false)
  assert.equal(report.branches.length, 1)

  const [branch] = report.branches
  assert.equal(branch.index, 0)
  assert.deepEqual(branch.comparators, ['>=1.0.0', '<2.0.0'])
  // numerically feasible: every comparator passes on its own
  assert.equal(branch.numericOk, true)
  assert.deepEqual(branch.numeric, [
    { comparator: '>=1.0.0', pass: true },
    { comparator: '<2.0.0', pass: true },
  ])
  // ...but the prerelease is not admitted
  assert.equal(branch.prerelease.relevant, true)
  assert.equal(branch.prerelease.admitted, false)
  assert.equal(branch.accepted, false)
  // consistent with satisfies(), whose return value is unchanged
  assert.equal(report.satisfied, satisfies('1.2.3-beta', '>=1.0.0 <2.0.0'))
})

test('includePrerelease option flips the verdict, and is reported', () => {
  const opts = { includePrerelease: true }
  const report = explain('1.2.3-beta', '>=1.0.0 <2.0.0', opts)
  assert.equal(report.options.includePrerelease, true)
  assert.equal(report.satisfied, true)
  const [branch] = report.branches
  assert.equal(branch.numericOk, true)
  assert.equal(branch.prerelease.admitted, true)
  assert.match(branch.prerelease.reason, /includePrerelease/)
  assert.equal(branch.accepted, true)
  assert.equal(report.satisfied, satisfies('1.2.3-beta', '>=1.0.0 <2.0.0', opts))
})

test('loose option is bound into the report', () => {
  const report = explain('1.2.3', '>=1.0.0 <2.0.0', { loose: true })
  assert.equal(report.options.loose, true)
  assert.equal(report.options.includePrerelease, false)
  assert.equal(report.satisfied, true)
})

test('OR branches keep their identity and get separate conclusions', () => {
  const range = '<1.0.0 || >=1.0.0 <2.0.0 || >=3.0.0'
  const report = explain('1.2.3-beta', range)
  assert.equal(report.branches.length, 3)
  assert.deepEqual(report.branches.map(b => b.index), [0, 1, 2])
  assert.deepEqual(report.branches.map(b => b.comparators), [
    ['<1.0.0'],
    ['>=1.0.0', '<2.0.0'],
    ['>=3.0.0'],
  ])
  // branch 0 and 2 fail numerically; branch 1 is numerically fine but
  // rejects the prerelease
  assert.equal(report.branches[0].numericOk, false)
  assert.equal(report.branches[0].accepted, false)
  assert.equal(report.branches[1].numericOk, true)
  assert.equal(report.branches[1].prerelease.admitted, false)
  assert.equal(report.branches[1].accepted, false)
  assert.equal(report.branches[2].numericOk, false)
  assert.equal(report.branches[2].accepted, false)
  assert.equal(report.satisfied, false)
  assert.equal(report.satisfied, satisfies('1.2.3-beta', range))
})

test('prerelease admitted by a comparator on the same tuple, not by toLower', () => {
  // 1.2.3-beta is NOT merely "less than" the bounds: the set carries
  // >=1.2.3-alpha, which admits prereleases of 1.2.3 explicitly.
  const report = explain('1.2.3-beta', '>=1.2.3-alpha <2.0.0')
  const [branch] = report.branches
  assert.equal(branch.numericOk, true)
  assert.equal(branch.prerelease.admitted, true)
  assert.match(branch.prerelease.reason, /1\.2\.3-alpha/)
  assert.equal(branch.accepted, true)
  assert.equal(report.satisfied, satisfies('1.2.3-beta', '>=1.2.3-alpha <2.0.0'))

  // a prerelease on a different tuple of the same set is still rejected
  const other = explain('1.2.4-beta', '>=1.2.3-alpha <2.0.0')
  assert.equal(other.branches[0].numericOk, true)
  assert.equal(other.branches[0].prerelease.admitted, false)
  assert.equal(other.satisfied, satisfies('1.2.4-beta', '>=1.2.3-alpha <2.0.0'))
})

test('three-version explanation example against >=1.0.0 <2.0.0', () => {
  const range = '>=1.0.0 <2.0.0'
  const versions = ['1.2.3-beta', '1.5.0', '2.5.0']
  const reports = versions.map(v => explain(v, range))

  // 1.2.3-beta: numerically feasible, prerelease rejected
  assert.equal(reports[0].branches[0].numericOk, true)
  assert.equal(reports[0].branches[0].prerelease.admitted, false)
  assert.equal(reports[0].satisfied, false)

  // 1.5.0: plain accept, prerelease rule not even relevant
  assert.equal(reports[1].branches[0].numericOk, true)
  assert.equal(reports[1].branches[0].prerelease.relevant, false)
  assert.equal(reports[1].satisfied, true)

  // 2.5.0: numerically out of range (<2.0.0 fails)
  assert.equal(reports[2].branches[0].numericOk, false)
  assert.deepEqual(reports[2].branches[0].numeric, [
    { comparator: '>=1.0.0', pass: true },
    { comparator: '<2.0.0', pass: false },
  ])
  assert.equal(reports[2].satisfied, false)

  // every conclusion agrees with satisfies()
  for (let i = 0; i < versions.length; i++) {
    assert.equal(reports[i].satisfied, satisfies(versions[i], range))
  }
})

test('normalized range output is reported, not the raw string', () => {
  const report = explain('1.5.0', '^1.0.0')
  assert.equal(report.range, '>=1.0.0 <2.0.0-0')
  assert.deepEqual(report.branches[0].comparators, ['>=1.0.0', '<2.0.0-0'])
})

test('invalid range or version: unsatisfied with an error, satisfies agrees', () => {
  const badRange = explain('1.2.3', 'blerg')
  assert.equal(badRange.satisfied, false)
  assert.match(badRange.error, /invalid range/)
  assert.equal(badRange.satisfied, satisfies('1.2.3', 'blerg'))

  const badVersion = explain('not.a.version', '>=1.0.0')
  assert.equal(badVersion.satisfied, false)
  assert.match(badVersion.error, /invalid version/)
  assert.equal(badVersion.satisfied, satisfies('not.a.version', '>=1.0.0'))
})
