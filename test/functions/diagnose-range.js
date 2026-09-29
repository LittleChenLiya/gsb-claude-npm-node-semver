'use strict'

const { test } = require('tap')
const semver = require('../../')
const diagnoseRange = require('../../functions/diagnose-range')
const rangeParse = require('../fixtures/range-parse.js')

const Range = require('../../classes/range')

const slice = (raw, [start, end]) => raw.slice(start, end)

test('diagnoseRange returns the raw range and its || branches', (t) => {
  const raw = '>=1.2.0 <2 || >=坏版本 || ^3.0.0'
  const d = diagnoseRange(raw)

  t.equal(d.raw, raw)
  t.equal(d.valid, false)
  t.equal(d.branches.length, 3)
  t.same(d.branches.map(b => b.range), [[0, 10], [14, 19], [23, 29]])
  t.same(d.branches.map(b => slice(raw, b.range)), [
    '>=1.2.0 <2',
    '>=坏版本',
    '^3.0.0',
  ])

  t.equal(d.branches[0].comparators.length, 2)
  t.same(d.branches[0].comparators.map(c => c.value), [
    '>=1.2.0',
    '<2.0.0-0',
  ])
  t.same(d.branches[0].comparators.map(c => slice(raw, c.range)), [
    '>=1.2.0',
    '<2',
  ])

  t.equal(d.branches[2].comparators.length, 2)
  t.same(d.branches[2].comparators.map(c => c.value), [
    '>=3.0.0',
    '<4.0.0-0',
  ])
  t.same(d.branches[2].comparators.map(c => slice(raw, c.range)), [
    '^3.0.0',
    '^3.0.0',
  ])

  t.equal(d.errors.length, 1)
  t.same(d.errors[0].range, [14, 19])
  t.equal(slice(raw, d.errors[0].range), '>=坏版本')
  t.equal(d.errors[0].input, '>=坏版本')
  t.equal(d.branches[1].errors.length, 1)
  t.equal(d.branches[1].errors[0], d.errors[0])

  // tri-state test(): satisfied / undecidable / satisfied
  t.equal(d.test('1.5.0'), true)
  t.equal(d.test('2.5.0'), null)
  t.equal(d.test('3.1.0'), true)

  t.end()
})

test('diagnoseRange pinpoints unfinished comparators', (t) => {
  const d = diagnoseRange('>=1.0.0 <2 || >=')
  t.equal(d.valid, false)
  t.equal(d.branches.length, 2)
  t.equal(d.errors.length, 1)
  t.same(d.errors[0].range, [14, 16])
  t.equal(d.errors[0].input, '>=')
  t.match(d.errors[0].message, /Invalid comparator/)
  // the first branch is still independently testable
  t.equal(d.test('1.5.0'), true)
  t.equal(d.test('2.0.0'), null)

  const lone = diagnoseRange('>')
  t.equal(lone.valid, false)
  t.same(lone.errors[0].range, [0, 1])
  t.equal(lone.test('9.9.9'), null)
  t.end()
})

test('diagnoseRange maps hyphen ranges back to the original text', (t) => {
  const raw = '  1.2  -  3.4.5  '
  const d = diagnoseRange(raw)
  t.equal(d.valid, true)
  const branch = d.branches[0]
  t.same(branch.range, [2, 15])
  t.ok(branch.hyphen)
  t.same(branch.hyphen.range, [2, 15])
  t.equal(slice(raw, branch.hyphen.range), '1.2  -  3.4.5')
  t.same(branch.comparators.map(c => c.value), ['>=1.2.0', '<=3.4.5'])
  t.same(branch.comparators.map(c => slice(raw, c.range)), ['1.2', '3.4.5'])
  t.same(branch.comparators.map(c => c.range), [[2, 5], [10, 15]])
  t.equal(d.test('2.0.0'), true)
  t.equal(d.test('3.4.6'), false)

  // wildcard side of a hyphen range
  const xrange = diagnoseRange('1.2.3 - 2.x')
  t.equal(xrange.valid, true)
  t.same(xrange.branches[0].comparators.map(c => c.value), [
    '>=1.2.3',
    '<3.0.0-0',
  ])
  t.same(xrange.branches[0].comparators.map(c => c.range), [[0, 5], [8, 11]])
  t.end()
})

test('diagnoseRange handles prereleases like the strict parser', (t) => {
  const d = diagnoseRange('^1.2.3-beta.4')
  t.equal(d.valid, true)
  t.same(d.branches[0].comparators.map(c => c.value), [
    '>=1.2.3-beta.4',
    '<2.0.0-0',
  ])
  t.equal(d.test('1.2.3-beta.5'), true)
  t.equal(d.test('1.2.4'), true)
  // a prerelease of a different patch is still rejected
  t.equal(d.test('1.2.4-alpha'), false)

  const incPre = diagnoseRange('~1.2', { includePrerelease: true })
  t.same(incPre.branches[0].comparators.map(c => c.value), [
    '>=1.2.0-0',
    '<1.3.0-0',
  ])
  t.equal(incPre.test('1.2.0-rc.1'), true)
  t.end()
})

test('diagnoseRange handles wildcard comparators', (t) => {
  for (const [raw, count, any] of [
    ['*', 0, true],
    ['x', 0, true],
    ['1.x', 2, false],
    ['2.*', 2, false],
    ['1.2.x', 2, false],
  ]) {
    const d = diagnoseRange(raw)
    t.equal(d.valid, true, raw)
    t.equal(d.branches[0].comparators.length, count, raw)
    t.equal(d.branches[0].any, any, raw)
  }

  const d = diagnoseRange('1.x || 2.*')
  t.equal(d.test('1.5.0'), true)
  t.equal(d.test('2.1.0'), true)
  t.equal(d.test('3.0.0'), false)
  t.end()
})

test('diagnoseRange treats empty branches as any', (t) => {
  for (const raw of ['', '   ', '||', '1.2.3 ||', '|| 1.2.3', '1 || || 2']) {
    const d = diagnoseRange(raw)
    t.equal(d.valid, true, JSON.stringify(raw))
    t.equal(d.test('1.2.3'), true, JSON.stringify(raw))
  }

  const d = diagnoseRange('1 || || 2')
  t.equal(d.branches.length, 3)
  t.equal(d.branches[1].any, true)
  t.same(d.branches[1].range, [5, 5])
  t.equal(d.branches[1].raw, ' ')
  t.end()
})

test('diagnoseRange reports every invalid token', (t) => {
  const raw = '>=1.0.0 bad ^2.0.0 || nope || >=3.0.0'
  const d = diagnoseRange(raw)
  t.equal(d.valid, false)
  t.same(d.errors.map(e => e.input), ['bad', 'nope'])
  t.same(d.errors.map(e => e.range), [[8, 11], [22, 26]])
  t.same(d.errors.map(e => slice(raw, e.range)), ['bad', 'nope'])
  t.equal(d.test('3.5.0'), true)
  t.equal(d.test('1.5.0'), null)
  t.end()
})

test('diagnoseRange agrees with satisfies for all fixture ranges', (t) => {
  const versions = [
    '0.0.0', '0.0.1', '0.1.0', '1.0.0', '1.2.0', '1.2.3', '1.2.3-alpha',
    '1.2.3-beta.2', '1.5.0', '2.0.0', '2.0.0-alpha', '2.1.0', '2.5.0',
    '3.0.0-rc.1', '3.1.0', '4.0.0',
  ]
  for (const [raw, wanted, options] of rangeParse) {
    const d = diagnoseRange(raw, options)
    const valid = semver.validRange(raw, options) !== null
    t.equal(d.valid, valid, `validity ${JSON.stringify(raw)}`)
    if (!valid) {
      t.ok(d.errors.length, `error locations ${JSON.stringify(raw)}`)
      continue
    }
    for (const version of versions) {
      t.equal(
        d.test(version),
        semver.satisfies(version, raw, options),
        `test(${JSON.stringify(raw)}, ${version})`
      )
    }
    // the overall canonical normalization (null sets, stars, dropped
    // empty branches) matches Range stringification / validRange
    const canonical = new Range(raw, options).range || '*'
    t.equal(
      canonical || '*',
      wanted,
      `canonical ${JSON.stringify(raw)}`
    )
  }
  t.end()
})

test('diagnoseRange is available on Range and the main export', (t) => {
  t.equal(typeof Range.diagnose, 'function')
  t.equal(semver.diagnoseRange, diagnoseRange)
  t.equal(Range.diagnose('1.2.3').test('1.2.3'), true)
  t.end()
})
