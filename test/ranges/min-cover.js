'use strict'

const { test } = require('tap')
const minCover = require('../../ranges/min-cover')
const satisfies = require('../../functions/satisfies')
const maxSatisfying = require('../../ranges/max-satisfying')
const semver = require('../../index.js')

// Naive greedy: walk consumers in order, and whenever one is not
// covered yet, add its highest satisfying version.
const greedy = (versions, ranges) => {
  const chosen = []
  for (const range of ranges) {
    if (chosen.some(v => satisfies(v, range))) {
      continue
    }
    const pick = maxSatisfying(versions, range)
    if (pick) {
      chosen.push(pick)
    }
  }
  return chosen
}

// Exhaustive search over every candidate subset for the minimum
// cover size, used to cross-check minCover.
const bruteForceMinSize = (versions, ranges) => {
  let best = Infinity
  for (let bits = 0; bits < (1 << versions.length); bits++) {
    const subset = versions.filter((_, i) => bits & (1 << i))
    if (subset.length >= best) {
      continue
    }
    if (ranges.every(r => subset.some(v => satisfies(v, r)))) {
      best = subset.length
    }
  }
  return best
}

const assignmentsSatisfy = (t, result, ranges) => {
  ranges.forEach((range, i) => {
    t.ok(satisfies(result.assignments[i], range),
      `assignment ${result.assignments[i]} satisfies ${range}`)
  })
}

test('exported from the main module', (t) => {
  t.equal(typeof semver.minCover, 'function')
  t.end()
})

test('basic minimal cover with assignments', (t) => {
  const versions = ['1.0.0', '1.5.0', '2.0.0', '2.2.0']
  const ranges = ['^1.0.0', '^2.0.0']
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['2.2.0', '1.5.0'])
  t.strictSame(result.assignments, ['1.5.0', '2.2.0'])
  t.strictSame(result.uncovered, [])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('ranges are matched with satisfies, never as strings', (t) => {
  // two different range strings with the same meaning share one version
  const versions = ['1.5.0']
  const ranges = ['^1.0.0', '>=1.0.0 <2.0.0']
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['1.5.0'])
  t.strictSame(result.assignments, ['1.5.0', '1.5.0'])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('greedy is suboptimal, minCover matches exhaustive search', (t) => {
  const versions = ['1.2.0', '1.5.0', '2.0.0']
  const ranges = ['>=1.0.0', '~1.5.0', '>=1.0.0 <2.0.0']
  const greedyPick = greedy(versions, ranges)
  t.strictSame(greedyPick, ['2.0.0', '1.5.0'], 'greedy picks 2 versions')
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['1.5.0'], 'one version covers all three')
  t.equal(result.versions.length, bruteForceMinSize(versions, ranges),
    'matches the exhaustive minimum')
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('ties break to the lexicographically largest descending list', (t) => {
  const versions = ['0.9.0', '1.0.0', '1.5.0', '2.0.0']
  const ranges = ['^1.0.0', '>=0.9.0 <1.5.0', '>=1.5.0']
  // minimal covers: {1.0.0, 2.0.0} and {1.5.0, 0.9.0};
  // [2.0.0, 1.0.0] beats [1.5.0, 0.9.0]
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['2.0.0', '1.0.0'])
  t.strictSame(result.assignments, ['1.0.0', '1.0.0', '2.0.0'])
  t.equal(result.versions.length, bruteForceMinSize(versions, ranges))
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('equivalent candidates are compressed to the highest version', (t) => {
  const versions = ['1.9.0', '1.5.0', '2.4.0', '2.0.0']
  const ranges = ['^1.0.0', '^2.0.0']
  // 1.5.0/1.9.0 and 2.0.0/2.4.0 cover identical consumer sets,
  // so only the highest of each class can be chosen
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['2.4.0', '1.9.0'])
  t.strictSame(result.assignments, ['1.9.0', '2.4.0'])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('prerelease versions', (t) => {
  const versions = ['1.0.0-alpha.1', '1.0.0-beta', '1.0.0']
  const ranges = ['>=1.0.0-alpha.1 <1.0.0', '^1.0.0']
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['1.0.0', '1.0.0-beta'])
  t.strictSame(result.assignments, ['1.0.0-beta', '1.0.0'])
  t.equal(result.versions.length, bruteForceMinSize(versions, ranges))
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('build metadata duplicates keep the first occurrence', (t) => {
  const versions = ['1.2.3+build.1', '1.2.3+build.2', '1.2.3']
  const ranges = ['1.2.3']
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['1.2.3+build.1'])
  t.strictSame(result.assignments, ['1.2.3+build.1'])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('duplicate versions keep the first occurrence', (t) => {
  const versions = ['1.0.0', '2.0.0', '1.0.0', '2.0.0']
  const ranges = ['^1.0.0', '^2.0.0']
  const result = minCover(versions, ranges)
  t.strictSame(result.versions, ['2.0.0', '1.0.0'])
  t.strictSame(result.assignments, ['1.0.0', '2.0.0'])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('empty consumer list', (t) => {
  const result = minCover(['1.0.0', '2.0.0'], [])
  t.strictSame(result, { versions: [], assignments: [], uncovered: [] })
  t.end()
})

test('uncoverable consumers are listed', (t) => {
  const result = minCover(['1.0.0'], ['^1.0.0', '^3.0.0', '>=4.0.0'])
  t.equal(result.versions, null)
  t.equal(result.assignments, null)
  t.strictSame(result.uncovered, [
    { index: 1, range: '^3.0.0' },
    { index: 2, range: '>=4.0.0' },
  ])
  const empty = minCover([], ['^1.0.0'])
  t.strictSame(empty.uncovered, [{ index: 0, range: '^1.0.0' }])
  t.end()
})

test('20 consumers boundary', (t) => {
  const versions = []
  const ranges = []
  for (let i = 0; i < 20; i++) {
    versions.push(`1.${i}.0`)
    ranges.push(`~1.${i}.0`)
  }
  const result = minCover(versions, ranges)
  t.equal(result.versions.length, 20)
  t.strictSame(result.assignments, versions.slice(),
    'each consumer gets its own version')
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('more than 20 consumers is an error', (t) => {
  const ranges = []
  for (let i = 0; i < 21; i++) {
    ranges.push(`~1.${i}.0`)
  }
  t.throws(() => minCover(['1.0.0'], ranges), RangeError)
  t.end()
})

test('invalid range or version fails the whole call', (t) => {
  t.throws(() => minCover(['1.0.0'], ['^1.0.0', 'not a range']), TypeError)
  t.throws(() => minCover(['nope'], ['^1.0.0']), TypeError)
  t.end()
})

test('non-array arguments are an error', (t) => {
  t.throws(() => minCover('1.0.0', ['^1.0.0']), TypeError)
  t.throws(() => minCover(['1.0.0'], '^1.0.0'), TypeError)
  t.end()
})

test('versions matching no consumer are ignored', (t) => {
  const ranges = ['^1.0.0']
  const result = minCover(['1.0.0', '9.9.9'], ranges)
  t.strictSame(result.versions, ['1.0.0'])
  t.strictSame(result.assignments, ['1.0.0'])
  assignmentsSatisfy(t, result, ranges)
  t.end()
})

test('input arrays are not modified', (t) => {
  const versions = ['1.0.0', '2.0.0', '1.5.0']
  const ranges = ['^1.0.0', '^2.0.0']
  const versionsBefore = versions.slice()
  const rangesBefore = ranges.slice()
  minCover(versions, ranges)
  t.strictSame(versions, versionsBefore)
  t.strictSame(ranges, rangesBefore)
  t.end()
})
