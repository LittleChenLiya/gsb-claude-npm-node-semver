'use strict'

const { test } = require('tap')
const explainIntersection = require('../../ranges/explain-intersection.js')
const Range = require('../../classes/range.js')
const SemVer = require('../../classes/semver.js')

// every witness must pass every original range's own test()
const check = (t, ranges, options, expected) => {
  const res = explainIntersection(ranges, options)
  if (expected === null) {
    t.equal(res.intersects, false, `no intersection: ${ranges}`)
    t.equal(res.version, null, 'no witness version')
    t.ok(res.conflicts.length > 0, 'reports at least one conflict')
    for (const conflict of res.conflicts) {
      t.ok(conflict.comparators.length > 0, 'conflict names comparators')
      for (const { range, comparator } of conflict.comparators) {
        t.ok(range >= 0 && range < ranges.length, 'valid range index')
        t.type(comparator, 'string', 'comparator is a string')
      }
    }
  } else {
    t.equal(res.intersects, true, `intersection exists: ${ranges}`)
    t.equal(res.version, expected, 'minimum witness version')
    t.equal(res.conflicts.length, 0, 'no conflicts when satisfiable')
    t.notMatch(res.version, /\\+/, 'witness has no build metadata')
    ranges.forEach((r, i) => {
      const range = new Range(r, options)
      t.ok(range.test(res.version), `witness satisfies range ${i}: ${r}`)
    })
  }
  return res
}

test('basic intersections', t => {
  check(t, ['>=1.2.0 <2', '>=1.5.0'], undefined, '1.5.0')
  check(t, ['<1.0.0', '>=1.0.0'], undefined, null)
  check(t, ['^1.2.3'], undefined, '1.2.3')
  check(t, ['~1.2.3', '1.2.3 - 1.4.0'], undefined, '1.2.3')
  check(t, ['1.2.x', '>=1.2.3'], undefined, '1.2.3')
  check(t, ['*', '*'], undefined, '0.0.0')
  check(t, ['*'], { includePrerelease: true }, '0.0.0-0')
  check(t, ['1.2.3', '>=1.0.0 <2.0.0'], undefined, '1.2.3')
  check(t, ['1.2.3', '1.2.4'], undefined, null)
  t.end()
})

test('prerelease opt-in per original range', t => {
  // default mode: ^1.0.0 does not allow 1.1.0 prereleases, so the
  // only versions satisfying the merged bounds are excluded
  const def = check(t, ['^1.0.0', '>=1.1.0-beta <1.1.0'], undefined, null)
  t.equal(def.conflicts[0].reason, 'prerelease-policy')
  // includePrerelease: 1.1.0-beta is the minimum witness
  check(t, ['^1.0.0', '>=1.1.0-beta <1.1.0'],
    { includePrerelease: true }, '1.1.0-beta')
  // a single range opting into its own prerelease tuple
  check(t, ['>=1.1.0-beta <1.1.0'], undefined, '1.1.0-beta')
  t.end()
})

test('across OR branches', t => {
  check(t, ['^1.0.0 || ^2.0.0', '>=1.5.0 <2.5.0'], undefined, '1.5.0')
  check(t, ['^2.0.0 || ^1.0.0', '>=1.5.0'], undefined, '1.5.0')
  check(t, ['<1.0.0 || >=2.0.0', '>=1.0.0 <2.0.0'], undefined, null)
  check(t, ['1.x || 2.x', '>=2.1.0', '<2.5.0'], undefined, '2.1.0')
  t.end()
})

test('same core, different prereleases', t => {
  check(t, ['>=1.0.0-alpha <1.0.0', '>=1.0.0-beta <1.0.0'], undefined, '1.0.0-beta')
  check(t, ['>=1.0.0-alpha.1 <1.0.0', '>=1.0.0-alpha.2 <1.0.0'], undefined, '1.0.0-alpha.2')
  check(t, ['<1.0.0-beta', '>=1.0.0-beta'], undefined, null)
  check(t, ['>1.0.0-alpha <1.0.0', '<1.0.0-beta'], undefined, '1.0.0-alpha.0')
  t.end()
})

test('MAX_SAFE_INTEGER boundaries', t => {
  const max = '9007199254740991'
  check(t, [`>=1.2.${max}`, '<1.3.0'], undefined, `1.2.${max}`)
  check(t, [`>1.2.${max}`, '<1.3.0'], { includePrerelease: true }, '1.3.0-0')
  check(t, [`>1.2.${max}`, '<1.3.0'], undefined, null)
  check(t, [`>${max}.${max}.${max}`], undefined, null)
  check(t, [`<=${max}.${max}.${max}`], undefined, '0.0.0')
  t.end()
})

test('build metadata is ignored and never returned', t => {
  check(t, ['>=1.2.0+build.1', '<1.3.0'], undefined, '1.2.0')
  check(t, ['1.2.3+foo', '>=1.0.0'], undefined, '1.2.3')
  t.end()
})

test('empty and invalid input', t => {
  t.throws(() => explainIntersection([]),
    new TypeError('explainIntersection requires at least one range'))
  t.throws(() => explainIntersection(),
    new TypeError('explainIntersection requires at least one range'))
  t.throws(() => explainIntersection(['not a range']), TypeError)
  // the empty string is the "any" range, just like *
  t.equal(explainIntersection(['']).version, '0.0.0')
  t.end()
})

test('conflict details', t => {
  const res = check(t, ['<1.0.0', '>=1.0.0'], undefined, null)
  t.match(res.conflicts, [{
    reason: 'bounds-conflict',
    comparators: [
      { range: 0, comparator: '<1.0.0' },
      { range: 1, comparator: '>=1.0.0' },
    ],
  }])
  const nullSet = check(t, ['<0.0.0-0', '*'], undefined, null)
  t.equal(nullSet.conflicts[0].reason, 'null-set')
  const eq = check(t, ['1.2.3', '1.2.4'], undefined, null)
  t.equal(eq.conflicts[0].reason, 'equal-mismatch')
  t.end()
})

test('accepts Range objects', t => {
  const res = explainIntersection([new Range('^1.0.0'), new Range('>=1.2.0')])
  t.equal(res.version, '1.2.0')
  t.end()
})

test('brute force oracle on a small version space', t => {
  const versions = []
  for (let major = 0; major <= 2; major++) {
    for (let minor = 0; minor <= 2; minor++) {
      for (let patch = 0; patch <= 2; patch++) {
        const core = `${major}.${minor}.${patch}`
        versions.push(core)
        for (const pre of ['0', 'alpha', 'alpha.1', 'beta']) {
          versions.push(`${core}-${pre}`)
        }
      }
    }
  }
  const sorted = versions.map(v => new SemVer(v)).sort((a, b) => a.compare(b))

  const pool = [
    '>=1.0.0 <2.0.0',
    '^1.0.0',
    '~1.1.0',
    '>=1.0.0-alpha <1.1.0',
    '1.0.x',
    '1.0.0 - 1.2.0',
    '<1.1.0',
    '>=0.1.0',
    '1.1.0-beta',
    '*',
    '<1.0.0 || >=2.0.0',
    '>=1.1.0-beta <2.0.0-0',
  ]

  const optionSets = [undefined, { includePrerelease: true }]
  t.plan(pool.length * pool.length * optionSets.length)
  for (const options of optionSets) {
    for (const r1 of pool) {
      for (const r2 of pool) {
        const ranges = [r1, r2]
        const parsed = ranges.map(r => new Range(r, options))
        const expected = sorted.find(v => parsed.every(r => r.test(v)))
        const res = explainIntersection(ranges, options)
        if (expected) {
          t.equal(res.version, expected.format(), `[${r1}] & [${r2}]`)
        } else {
          t.equal(res.version, null, `[${r1}] & [${r2}] empty`)
        }
      }
    }
  }
})
