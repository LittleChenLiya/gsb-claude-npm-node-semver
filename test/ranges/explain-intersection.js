'use strict'

const { test } = require('tap')
const explainIntersection = require('../../ranges/explain-intersection.js')
const Range = require('../../classes/range.js')

// every witness must pass each original range's own test(), which is
// where the per-range default prerelease exclusion lives
const checkWitness = (t, ranges, options, expectVersion) => {
  const res = explainIntersection(ranges, options)
  ranges = [].concat(ranges)
  t.equal(res.intersects, true, 'intersects: ' + ranges.join(' && '))
  t.equal(res.version, expectVersion, 'minimal witness')
  t.notOk(res.version.includes('+'), 'witness carries no build metadata')
  for (const r of ranges) {
    t.ok(new Range(r, options).test(res.version),
      res.version + ' satisfies ' + r)
  }
  return res
}

const checkConflict = (t, ranges, options, reason) => {
  const res = explainIntersection(ranges, options)
  t.equal(res.intersects, false, 'does not intersect: ' + ranges.join(' && '))
  t.notOk('version' in res, 'no witness version')
  t.ok(res.conflicts.length > 0, 'reports conflicts')
  for (const conflict of res.conflicts) {
    t.ok(conflict.comparators.length > 0, 'conflict has comparators')
    for (const { index, comparator } of conflict.comparators) {
      t.ok(index >= 0 && index < ranges.length, 'valid range index')
      t.ok(new Range(comparator, options), 'valid comparator ' + comparator)
    }
  }
  if (reason) {
    t.ok(res.conflicts.some(c => c.reason === reason),
      'has a ' + reason + ' conflict')
  }
  return res
}

test('acceptance cases', t => {
  checkWitness(t, ['>=1.2.0 <2', '>=1.5.0'], {}, '1.5.0')
  const res = checkConflict(t, ['<1.0.0', '>=1.0.0'], {}, 'conflicting-bounds')
  t.match(res.conflicts[0].comparators, [
    { index: 1, comparator: '>=1.0.0' },
    { index: 0, comparator: '<1.0.0' },
  ], 'conflict comparators tagged with range indices')
  t.end()
})

test('prerelease gating is applied per original range', t => {
  // merged bounds allow 1.1.0-beta, but ^1.0.0 admits no 1.1.0 prerelease
  checkConflict(t, ['^1.0.0', '>=1.1.0-beta <1.1.0'], {}, 'prerelease-excluded')
  checkWitness(t, ['^1.0.0', '>=1.1.0-beta <1.1.0'],
    { includePrerelease: true }, '1.1.0-beta')
  t.end()
})

test('across OR branches', t => {
  checkWitness(t, ['<1.0.0 || >=2.0.0', '1.5.x || 2.3.x'], {}, '2.3.0')
  checkWitness(t, ['^1.0.0 || ^3.0.0', '~3.0.0 || <1.2.0'], {}, '1.0.0')
  checkConflict(t, ['<1.0.0 || >=3.0.0', '>=1.0.0 <2.0.0'], {},
    'conflicting-bounds')
  t.end()
})

test('same core with different prereleases', t => {
  checkWitness(t,
    ['>=1.0.0-alpha <1.0.0-beta.5', '>=1.0.0-alpha.2 <=1.0.0-beta.3'],
    {}, '1.0.0-alpha.2')
  checkWitness(t, ['1.0.0-alpha.3', '>=1.0.0-alpha <1.0.0'], {},
    '1.0.0-alpha.3')
  checkConflict(t, ['1.0.0-alpha', '1.0.0-beta'], {}, 'conflicting-equalities')
  t.end()
})

test('MAX_SAFE_INTEGER boundaries', t => {
  const max = '9007199254740991'
  checkWitness(t, ['>=' + max + '.0.0', '<=' + max + '.0.0'], {},
    max + '.0.0')
  // default mode excludes the prerelease successor, so the release wins
  checkWitness(t, ['>' + max + '.' + max + '.9007199254740990'], {},
    max + '.' + max + '.' + max)
  checkWitness(t, ['>' + max + '.' + max + '.9007199254740990'],
    { includePrerelease: true }, max + '.' + max + '.' + max + '-0')
  checkConflict(t, ['>' + max + '.' + max + '.' + max], {},
    'conflicting-bounds')
  t.end()
})

test('successor versions across component rollover', t => {
  // >1.0.0-alpha is followed by 1.0.0-alpha.0 in the version ordering
  checkWitness(t, ['>1.0.0-alpha'], {}, '1.0.0-alpha.0')
  checkWitness(t, ['>1.0.0-alpha'], { includePrerelease: true },
    '1.0.0-alpha.0')
  // patch at MAX_SAFE_INTEGER rolls over into the minor component
  checkWitness(t, ['>1.0.9007199254740991'], {}, '1.1.0')
  checkWitness(t, ['>1.0.9007199254740991'], { includePrerelease: true },
    '1.1.0-0')
  // patch and minor at MAX_SAFE_INTEGER roll over into the major component
  checkWitness(t, ['>1.9007199254740991.9007199254740991'], {}, '2.0.0')
  checkWitness(t, ['>1.9007199254740991.9007199254740991'],
    { includePrerelease: true }, '2.0.0-0')
  t.end()
})

test('range syntaxes normalize to the same semantics', t => {
  checkWitness(t, ['1.2.3 - 2.3.4', '>=1.5.0'], {}, '1.5.0')
  checkWitness(t, ['~1.2.3', '^1.0.0', '1.2.x'], {}, '1.2.3')
  checkWitness(t, ['*', '>=2.0.0'], {}, '2.0.0')
  checkWitness(t, ['1.2.3+build.5', '>=1.0.0'], {}, '1.2.3')
  t.end()
})

test('open endpoints and empty ranges', t => {
  checkWitness(t, ['>=1.0.0'], {}, '1.0.0')
  checkWitness(t, ['<2.0.0'], {}, '0.0.0')
  checkWitness(t, ['<2.0.0'], { includePrerelease: true }, '0.0.0-0')
  checkConflict(t, ['>2.0.0 <1.0.0'], {}, 'conflicting-bounds')
  checkConflict(t, ['<0.0.0-0'], {}, 'null-set')
  t.end()
})

test('input validation', t => {
  t.throws(() => explainIntersection([]), TypeError, 'needs a range')
  t.throws(() => explainIntersection(), TypeError, 'needs an argument')
  t.throws(() => explainIntersection(['>=1.0.0', 'not a range']),
    /Invalid range at index 1/, 'invalid range reports its index')
  t.end()
})

test('single range input and equality edge cases', t => {
  checkWitness(t, '>=1.0.0', {}, '1.0.0')
  checkWitness(t, [new Range('^1.0.0'), '>=1.2.0'], {}, '1.2.0')
  checkWitness(t, ['1.0.0', '>0.5.0'], {}, '1.0.0')
  checkConflict(t, ['1.0.0', '>1.0.0'], {}, 'conflicting-equalities')
  // exact prerelease version fits the merged bounds, but the second
  // range does not admit prereleases of its tuple
  checkConflict(t, ['1.0.0-alpha', '>=0.5.0 <2.0.0'], {},
    'prerelease-excluded')
  // no version exists between adjacent bounds
  checkConflict(t, ['>1.0.0', '<1.0.1-0'], {}, 'conflicting-bounds')
  t.end()
})

test('bound merging and conflict deduplication', t => {
  // equal-version bounds of mixed strictness collapse to the stricter one
  checkWitness(t, ['>1.0.0', '>1.0.0 <2.0.0'], {}, '1.0.1')
  checkConflict(t, ['>=1.0.0', '>1.0.0 <1.0.0'], {}, 'conflicting-bounds')
  checkConflict(t, ['<1.0.0', '<=1.0.0 >=1.0.0'], {}, 'conflicting-bounds')
  checkWitness(t, ['<=2.0.0', '<2.0.0 >=1.0.0'], {}, '1.0.0')
  // identical conflicts from several OR branches are reported once
  const res = checkConflict(t, ['<1.0.0 || <1.0.0', '>=1.0.0'], {},
    'conflicting-bounds')
  t.equal(res.conflicts.length, 1, 'duplicate conflicts deduplicated')
  t.end()
})

// exhaustive small-version oracle: the analytic result must agree with
// brute-force Range.test() over a dense sample of small versions
test('exhaustive oracle over small versions', t => {
  const tuples = [
    '0.0.0', '0.0.1', '0.1.0', '1.0.0', '1.0.1',
    '1.1.0', '1.2.0', '1.2.3', '1.5.0', '2.0.0',
  ]
  const versions = []
  for (const tuple of tuples) {
    versions.push(tuple + '-0', tuple + '-alpha', tuple + '-alpha.0',
      tuple + '-alpha.1', tuple + '-beta', tuple)
  }

  const rangeSets = [
    ['>=1.2.0 <2', '>=1.5.0'],
    ['<1.0.0', '>=1.0.0'],
    ['^1.0.0', '>=1.1.0-beta <1.1.0'],
    ['^1.0.0', '~1.0.0'],
    ['^0.0.1', '<1.0.0'],
    ['1.2.x', '>=1.2.3-alpha'],
    ['1.0.0 - 1.5.0', '<=1.2.3 >=1.0.1'],
    ['<1.0.0 || >=2.0.0', '1.5.x || 2.0.0-0'],
    ['*', '<1.0.0'],
    ['>=1.0.0-alpha <1.0.0', '>=1.0.0-alpha.1'],
    ['1.0.0-alpha', '>=1.0.0-0 <1.0.0'],
    ['>1.0.0', '<1.0.1'],
    ['>1.0.0', '<1.0.1', '>=1.0.1-0'],
    ['0.0.x', '>=0.0.0-0'],
    ['1.2.3', '^1.0.0'],
    ['1.2.3', '1.5.0'],
  ]

  for (const options of [{}, { includePrerelease: true }]) {
    for (const ranges of rangeSets) {
      const parsed = ranges.map(r => new Range(r, options))
      const satisfying = versions.filter(v =>
        parsed.every(range => range.test(v)))
      const res = explainIntersection(ranges, options)
      const label = ranges.join(' && ') + ' ' + JSON.stringify(options)
      if (satisfying.length === 0) {
        t.equal(res.intersects, false, 'oracle agrees: empty ' + label)
      } else {
        t.equal(res.intersects, true, 'oracle agrees: satisfiable ' + label)
        t.equal(res.version, satisfying[0], 'minimal witness ' + label)
        t.ok(parsed.every(range => range.test(res.version)),
          'witness verified by Range.test ' + label)
      }
    }
  }
  t.end()
})
