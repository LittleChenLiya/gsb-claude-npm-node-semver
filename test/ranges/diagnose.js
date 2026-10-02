'use strict'

const { test } = require('tap')
const diagnoseRange = require('../../ranges/diagnose')
const satisfies = require('../../functions/satisfies')
const Range = require('../../classes/range')
const Comparator = require('../../classes/comparator')
const rangeInclude = require('../fixtures/range-include.js')
const rangeExclude = require('../fixtures/range-exclude.js')

test('broken branch in the middle of a range', (t) => {
  const raw = '>=1.2.0 <2 || >=坏版本 || ^3.0.0'
  const result = diagnoseRange(raw)
  t.notOk(result.valid)
  t.equal(result.raw, raw)
  t.equal(result.branches.length, 3)

  t.equal(result.test('1.5.0'), true, '1.5.0 satisfied by the first branch')
  t.equal(result.test('2.5.0'), undefined, '2.5.0 cannot be determined')
  t.equal(result.test('3.1.0'), true, '3.1.0 satisfied by the third branch')

  const [b1, b2, b3] = result.branches
  t.ok(b1.valid)
  t.equal(b1.raw, '>=1.2.0 <2')
  t.equal(b1.start, 0)
  t.equal(b1.end, 10)
  t.same(b1.errors, [])
  t.notOk(b2.valid)
  t.equal(b2.raw, '>=坏版本')
  t.equal(raw.slice(b2.start, b2.end), b2.raw)
  t.ok(b3.valid)
  t.equal(b3.raw, '^3.0.0')
  t.equal(raw.slice(b3.start, b3.end), b3.raw)

  t.equal(result.errors.length, 1)
  const [err] = result.errors
  t.equal(err.raw, '>=坏版本')
  t.equal(err.start, 14)
  t.equal(err.end, 19)
  t.equal(raw.slice(err.start, err.end), '>=坏版本')
  t.equal(b2.errors[0], err, 'branch errors are the same objects')

  t.equal(b1.comparators.length, 2)
  const [c1, c2] = b1.comparators
  t.equal(c1.type, 'comparator')
  t.equal(c1.raw, '>=1.2.0')
  t.equal(c1.start, 0)
  t.equal(c1.end, 7)
  t.equal(c2.raw, '<2')
  t.equal(raw.slice(c2.start, c2.end), '<2')
  t.ok(c1.comparators[0] instanceof Comparator)
  t.same(c1.comparators.map(String), ['>=1.2.0'])
  t.end()
})

test('unfinished comparators', (t) => {
  const lone = diagnoseRange('>=')
  t.notOk(lone.valid)
  t.same(lone.errors.map(e => [e.start, e.end, e.raw]), [[0, 2, '>=']])
  t.match(lone.errors[0], { message: 'Incomplete comparator: >=' })
  t.equal(lone.test('1.2.3'), undefined)

  const spaced = diagnoseRange('>= || 1.2.3')
  t.notOk(spaced.valid)
  t.match(spaced.errors[0], { message: 'Incomplete comparator: >=', start: 0, end: 2 })
  t.equal(spaced.test('1.2.3'), true)
  t.equal(spaced.test('9.9.9'), undefined)

  const tilde = diagnoseRange('1.2.3 || ~')
  t.match(tilde.errors[0], { message: 'Incomplete comparator: ~', start: 9, end: 10 })

  const badMerged = diagnoseRange('>= 坏')
  t.notOk(badMerged.valid)
  t.match(badMerged.errors[0], { raw: '>= 坏', start: 0, end: 4 })
  t.end()
})

test('hyphen ranges keep their source positions', (t) => {
  const raw = '1.2.3 - 2.0.0 || >= 3.0.0'
  const result = diagnoseRange(raw)
  t.ok(result.valid)
  t.equal(result.test('1.5.0'), true)
  t.equal(result.test('2.5.0'), false)
  t.equal(result.test('3.5.0'), true)

  const [b1, b2] = result.branches
  t.equal(b1.comparators.length, 1)
  const hyphen = b1.comparators[0]
  t.equal(hyphen.type, 'hyphen-range')
  t.equal(hyphen.raw, '1.2.3 - 2.0.0')
  t.equal(hyphen.start, 0)
  t.equal(hyphen.end, 13)
  t.equal(raw.slice(hyphen.start, hyphen.end), hyphen.raw)
  t.same(hyphen.comparators.map(String), ['>=1.2.3', '<=2.0.0'])
  t.same([hyphen.from.raw, hyphen.separator.raw, hyphen.to.raw], ['1.2.3', '-', '2.0.0'])

  const op = b2.comparators[0]
  t.equal(op.raw, '>= 3.0.0')
  t.equal(raw.slice(op.start, op.end), '>= 3.0.0')
  t.same(op.comparators.map(String), ['>=3.0.0'])
  t.end()
})

test('unfinished and invalid hyphen ranges', (t) => {
  const trailing = diagnoseRange('1.2.3 -')
  t.notOk(trailing.valid)
  t.match(trailing.errors[0], { message: 'Incomplete hyphen range: -', start: 6, end: 7, raw: '-' })
  t.equal(trailing.test('1.2.3'), undefined)

  const badTo = diagnoseRange('1.2.3 - 坏')
  t.match(badTo.errors[0], { message: 'Invalid comparator: 坏', start: 8, end: 9, raw: '坏' })

  const badFrom = diagnoseRange('坏 - 1.2.3')
  t.match(badFrom.errors[0], { message: 'Invalid comparator: 坏', start: 0, end: 1, raw: '坏' })

  const badBoth = diagnoseRange('坏 - 坏')
  t.equal(badBoth.errors.length, 2)

  const notHyphen = diagnoseRange('>=1.0.0 - 2.0.0')
  t.match(notHyphen.errors[0], { message: 'Invalid hyphen range', start: 8, end: 9, raw: '-' })

  const stray = diagnoseRange('- 1.2.3')
  t.match(stray.errors[0], { message: 'Incomplete hyphen range: -', start: 0, end: 1 })

  const dbl = diagnoseRange('1.2.3 - - 2.0.0')
  t.equal(dbl.errors.length, 2)

  const chained = diagnoseRange('1.2 - 3.4 - 5.6')
  t.equal(chained.errors.length, 1)
  t.match(chained.errors[0], { raw: '-', start: 10, end: 11 })

  const afterOp = diagnoseRange('>= - 1.2.3')
  t.equal(afterOp.errors.length, 2)
  t.end()
})

test('prerelease ranges', (t) => {
  const raw = '>=1.2.3-alpha <2.0.0 || 1.2.3-alpha.1 - 1.2.3-beta.2'
  const result = diagnoseRange(raw)
  t.ok(result.valid)
  t.equal(result.test('1.2.3-beta'), true)
  t.equal(result.test('1.2.3-alpha.2'), true)
  t.equal(result.test('2.0.0'), false)
  const hyphen = result.branches[1].comparators[0]
  t.equal(hyphen.type, 'hyphen-range')
  t.equal(hyphen.raw, '1.2.3-alpha.1 - 1.2.3-beta.2')
  t.end()
})

test('wildcards', (t) => {
  const result = diagnoseRange('1.2.x || *')
  t.ok(result.valid)
  t.equal(result.test('1.2.9'), true)
  t.equal(result.test('9.9.9'), true)
  t.equal(diagnoseRange('1.x').test('1.4.0'), true)
  t.equal(diagnoseRange('1.x').test('2.0.0'), false)
  t.equal(diagnoseRange('<=2.x').test('2.5.0'), true)
  t.end()
})

test('empty branches match anything, just like the Range class', (t) => {
  for (const raw of ['', '||', '1.2.3 ||', '|| 1.2.3', '1.2.3 || || 2.0.0']) {
    const result = diagnoseRange(raw)
    t.ok(result.valid, JSON.stringify(raw) + ' is valid')
    t.same(result.errors, [])
    t.equal(result.test('9.9.9'), satisfies('9.9.9', raw))
  }
  const result = diagnoseRange('1.2.3 ||')
  t.equal(result.branches.length, 2)
  const empty = result.branches[1]
  t.equal(empty.raw, '')
  t.same(empty.comparators, [])
  t.ok(empty.test('9.9.9'))
  t.end()
})

test('multiple errors are all reported in order', (t) => {
  const raw = '>=坏 || <xyz || ~'
  const result = diagnoseRange(raw)
  t.notOk(result.valid)
  t.same(result.errors.map(e => e.raw), ['>=坏', '<xyz', '~'])
  t.same(result.errors.map(e => raw.slice(e.start, e.end)), ['>=坏', '<xyz', '~'])
  const starts = result.errors.map(e => e.start)
  t.same(starts, [...starts].sort((a, b) => a - b), 'errors are in source order')
  t.equal(result.test('1.2.3'), undefined)
  t.end()
})

test('whitespace maps back to the original string', (t) => {
  const raw = '  >= 1.2.0    <2  '
  const result = diagnoseRange(raw)
  t.ok(result.valid)
  const [branch] = result.branches
  t.equal(branch.raw, '>= 1.2.0    <2')
  t.equal(branch.start, 2)
  t.equal(branch.end, 16)
  const [c1, c2] = branch.comparators
  t.equal(c1.raw, '>= 1.2.0')
  t.equal(raw.slice(c1.start, c1.end), '>= 1.2.0')
  t.equal(c2.raw, '<2')
  t.equal(raw.slice(c2.start, c2.end), '<2')
  t.equal(result.test('1.5.0'), true)
  t.equal(result.test('2.5.0'), false)
  t.end()
})

test('invalid branches never match', (t) => {
  const result = diagnoseRange('>=坏 || ^1.0.0')
  t.equal(result.branches[0].test('1.0.0'), false)
  t.equal(result.branches[1].test('1.5.0'), true)
  t.same(result.branches[0].comparators[0].comparators, [])
  t.end()
})

test('input handling', (t) => {
  t.throws(() => diagnoseRange(1), TypeError)
  t.throws(() => diagnoseRange(null), TypeError)
  const fromRange = diagnoseRange(new Range('^1.2.3'))
  t.ok(fromRange.valid)
  t.equal(fromRange.raw, '^1.2.3')
  t.equal(fromRange.test('1.5.0'), true)
  t.equal(fromRange.test('2.0.0'), false)
  t.end()
})

test('fully valid ranges agree with satisfies', (t) => {
  for (const [range, version, options] of [...rangeInclude, ...rangeExclude]) {
    const result = diagnoseRange(range, options)
    if (!options || !options.loose) {
      t.ok(result.valid, `strict range parses cleanly: ${JSON.stringify(range)}`)
    }
    if (result.valid) {
      t.equal(result.test(version), satisfies(version, range, options),
        `${JSON.stringify(version)} vs ${JSON.stringify(range)}`)
    }
  }
  t.end()
})
