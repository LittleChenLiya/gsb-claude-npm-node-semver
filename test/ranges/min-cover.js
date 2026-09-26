'use strict'

const { test } = require('tap')
const semver = require('../../index.js')
const minCover = require('../../ranges/min-cover')
const Range = require('../../classes/range')

// Independent brute force reference: enumerate every subset of the distinct
// coverage sets and keep the smallest cover, breaking ties by the lexicographic
// comparison of descending version lists.
const bruteForce = (consumers, versions, options) => {
  const ranges = consumers.map((consumer) => new Range(consumer.range, options))
  const groups = new Map()
  versions.forEach((version, index) => {
    let parsed = null
    try {
      parsed = new semver.SemVer(version, options)
    } catch (er) {
      return
    }
    let mask = 0
    ranges.forEach((range, i) => {
      if (range.test(parsed)) {
        mask |= 1 << i
      }
    })
    // First input occurrence represents each coverage-set equivalence class.
    if (mask !== 0 && !groups.has(mask)) {
      groups.set(mask, { version, mask, index })
    }
  })
  const candidates = Array.from(groups.values())
    .sort((a, b) =>
      semver.compare(b.version, a.version) || a.index - b.index)
  const full = (1 << consumers.length) - 1
  let best = null
  for (let bits = 1; bits < (1 << candidates.length); bits++) {
    let mask = 0
    const picked = []
    for (let i = 0; i < candidates.length; i++) {
      if (bits & (1 << i)) {
        mask |= candidates[i].mask
        picked.push(candidates[i].version)
      }
    }
    if (mask !== full) {
      continue
    }
    if (best === null || picked.length < best.length ||
      (picked.length === best.length && lexGreater(picked, best, options))) {
      best = picked
    }
  }
  return best
}

const lexGreater = (a, b, options) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (b[i] === undefined) {
      return true
    }
    if (a[i] === undefined) {
      return false
    }
    const compared = semver.compare(a[i], b[i], options)
    if (compared !== 0) {
      return compared > 0
    }
  }
  return false
}

const mulberry32 = (seed) => {
  let a = seed
  return () => {
    a |= 0
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

test('minimum cover basics', (t) => {
  const consumers = ['^1.0.0', '^2.0.0', '^3.0.0']
  const versions = ['3.0.0', '2.5.0', '1.5.0']
  const result = minCover(consumers, versions)
  t.same(result.versions, ['3.0.0', '2.5.0', '1.5.0'])
  t.same(result.assignments, ['1.5.0', '2.5.0', '3.0.0'])
  t.equal(result.covered, true)
  t.same(result.uncovered, [])
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index]),
      `${version} satisfies ${consumers[index]}`))
  t.end()
})

test('a single shared version covers all consumers', (t) => {
  // A greedy that hands each consumer its own highest satisfying version
  // picks three here; one shared version is the minimum cover.
  const consumers = ['^1.0.0', '~1.2.0', '1.2.3']
  const versions = ['1.5.0', '1.2.9', '1.2.3', '1.0.0']
  const greedy = consumers.map((range) => semver.maxSatisfying(versions, range))
  const result = minCover(consumers, versions)
  t.same(greedy, ['1.5.0', '1.2.9', '1.2.3'])
  t.equal(greedy.length, 3)
  t.same(result.versions, ['1.2.3'])
  t.same(result.assignments, ['1.2.3', '1.2.3', '1.2.3'])
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index])))
  t.end()
})

test('ties prefer the lexicographically larger descending version list', (t) => {
  // Two distinct 2-version covers exist:
  //   [2.5.0, 1.5.0] and [2.0.0, 1.0.0]
  const consumers = [
    '1.5.0 || 1.0.0', // c0
    '1.5.0 || 2.0.0', // c1
    '2.5.0 || 2.0.0', // c2
    '2.5.0 || 1.0.0', // c3
  ]
  const versions = ['1.5.0', '2.5.0', '2.0.0', '1.0.0']
  const result = minCover(consumers, versions)
  t.equal(result.versions.length, 2)
  t.same(result.versions, ['2.5.0', '1.5.0'])
  t.same(result.assignments, ['1.5.0', '1.5.0', '2.5.0', '2.5.0'])
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index]),
      `${version} satisfies ${consumers[index]}`))
  t.end()
})

test('prereleases follow satisfies rules', (t) => {
  // Without includePrerelease the prerelease only satisfies the exact
  // prerelease comparator, so two versions are required.
  const consumers = ['^1.0.0', '1.5.0-alpha']
  const versions = ['1.5.0-alpha', '1.5.0']
  const result = minCover(consumers, versions)
  t.same(result.versions, ['1.5.0', '1.5.0-alpha'])
  t.same(result.assignments, ['1.5.0', '1.5.0-alpha'])
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index])))

  // A prerelease below the range is not a candidate by default.
  t.equal(minCover(['^1.0.0'], ['1.5.0-beta']).covered, false)

  // With includePrerelease both prereleases satisfy the same range, so they
  // are equivalent candidates and the first input occurrence is retained.
  const pre = minCover(['^1.0.0'], ['1.5.0-alpha', '1.5.0-beta'], {
    includePrerelease: true,
  })
  t.same(pre.versions, ['1.5.0-alpha'])
  t.ok(semver.satisfies(pre.assignments[0], '^1.0.0', {
    includePrerelease: true,
  }))

  // When the coverage sets differ, the higher precedence prerelease wins.
  const split = minCover(['1.5.0-alpha', '1.5.0-beta'],
    ['1.5.0-alpha', '1.5.0-beta'], { includePrerelease: true })
  t.same(split.versions, ['1.5.0-beta', '1.5.0-alpha'])
  t.ok(semver.satisfies(split.assignments[0], '1.5.0-alpha', {
    includePrerelease: true,
  }))
  t.ok(semver.satisfies(split.assignments[1], '1.5.0-beta', {
    includePrerelease: true,
  }))
  t.end()
})

test('build metadata and duplicate versions collapse by coverage set', (t) => {
  const consumers = ['^1.0.0', '>=2.0.0']
  const versions = ['1.0.0+z', '1.0.0+z', '1.0.0+a', '2.0.0', 'garbage']
  const result = minCover(consumers, versions)
  // The 1.0.0 builds are semver-equal with one coverage set; the first
  // occurrence is kept. 2.0.0 is the distinct >=2.0.0 coverage set.
  t.equal(result.versions.length, 2)
  t.equal(result.versions[1], '1.0.0+z')
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index])))

  // Build metadata is ignored for precedence ordering, not string-compared.
  const single = minCover(['1.0.0'], ['1.0.0+a', '1.0.0+b', '1.0.0'])
  t.same(single.versions, ['1.0.0+a'])
  t.end()
})

test('empty consumers', (t) => {
  const result = minCover([], ['1.0.0', '2.0.0'])
  t.equal(result.covered, true)
  t.same(result.versions, [])
  t.same(result.assignments, [])
  t.same(result.uncovered, [])

  // An empty range string means * to node-semver, same as satisfies('').
  const anyRange = minCover([''], ['3.0.0'])
  t.same(anyRange.versions, ['3.0.0'])
  t.end()
})

test('consumers with no candidate versions are reported', (t) => {
  const result = minCover(['^1.0.0', '^2.0.0'], ['1.2.3'])
  t.equal(result.covered, false)
  t.same(result.versions, [])
  t.same(result.assignments, [null, null])
  t.same(result.uncovered, ['1'])
  t.same(result.uncoveredConsumers, [{
    name: '1', range: '^2.0.0', index: 1,
  }])

  const named = minCover([{ name: 'widget', range: '^9.0.0' }], ['1.0.0'])
  t.equal(named.covered, false)
  t.same(named.uncovered, ['widget'])
  t.end()
})

test('invalid ranges and oversized input throw', (t) => {
  t.throws(() => minCover(['not a range'], ['1.0.0']), {
    name: 'TypeError', code: 'EINVALIDRANGE',
  })
  t.throws(() => minCover(['*', 'nope!!'], ['1.0.0']), {
    name: 'TypeError', code: 'EINVALIDRANGE',
  })
  t.throws(() => minCover(new Array(21).fill('*'), ['1.0.0']), {
    name: 'RangeError',
    message: 'min-cover supports at most 20 consumers, got 21',
  })
  t.equal(minCover.MAX_CONSUMERS, 20)
  t.throws(() => minCover(42, ['1.0.0']), TypeError)
  t.throws(() => minCover([42], ['1.0.0']), TypeError)
  t.throws(() => minCover([{}], ['1.0.0']), TypeError)
  t.throws(() => minCover(['*'], null), TypeError)
  t.end()
})

test('the 20 consumer boundary is solved exactly', (t) => {
  const consumers = []
  const versions = []
  for (let i = 1; i <= 20; i++) {
    consumers.push(`${i}.0.0`)
    versions.push(`${i}.0.0`)
  }
  const result = minCover(consumers, versions)
  t.equal(result.covered, true)
  t.equal(result.versions.length, 20)
  t.same(result.versions, versions.slice().sort(semver.rcompare))
  result.assignments.forEach((version, index) =>
    t.equal(version, consumers[index]))
  t.end()
})

test('named object consumers are supported', (t) => {
  const consumers = [
    { name: 'a', range: '^1.0.0' },
    { name: 'b', range: '~1.2.0' },
  ]
  const result = minCover(consumers, ['1.2.3'])
  t.same(result.versions, ['1.2.3'])
  t.same(result.assignments, ['1.2.3', '1.2.3'])
  result.assignments.forEach((version, index) =>
    t.ok(semver.satisfies(version, consumers[index].range)))
  t.end()
})

test('input lists and options are not modified', (t) => {
  const consumers = ['^1.0.0', '^2.0.0']
  const versions = ['2.0.0', '1.0.0', '2.0.0']
  const options = { includePrerelease: false }
  minCover(consumers, versions, options)
  t.same(consumers, ['^1.0.0', '^2.0.0'])
  t.same(versions, ['2.0.0', '1.0.0', '2.0.0'])
  t.same(options, { includePrerelease: false })
  t.end()
})

test('random instances match exhaustive subset enumeration', (t) => {
  const pool = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0',
    '3.0.0', '3.4.0', '4.0.0', '4.2.0']
  const random = mulberry32(0x5EEDED)
  for (let trial = 0; trial < 300; trial++) {
    const nConsumers = 1 + Math.floor(random() * 6)
    const consumers = []
    for (let i = 0; i < nConsumers; i++) {
      const parts = []
      for (const version of pool) {
        if (random() < 0.35) {
          parts.push(version)
        }
      }
      if (!parts.length) {
        parts.push(pool[Math.floor(random() * pool.length)])
      }
      consumers.push(parts.join('||'))
    }
    let versions = pool.filter(() => random() < 0.7)
    if (!versions.length) {
      versions = [pool[0]]
    }
    if (random() < 0.3) {
      versions.push(versions[Math.floor(random() * versions.length)])
    }
    const expected = bruteForce(consumers.map((range) => ({ range })), versions)
    const result = minCover(consumers, versions)
    if (expected === null) {
      t.equal(result.covered, false, `trial ${trial} is uncoverable`)
      t.same(result.versions, [])
    } else {
      t.equal(result.covered, true, `trial ${trial} is coverable`)
      t.equal(result.versions.length, expected.length,
        `trial ${trial} minimum size matches brute force`)
      t.same(result.versions, expected,
        `trial ${trial} tie-break matches brute force`)
      result.assignments.forEach((version, index) =>
        t.ok(version !== null && semver.satisfies(version, consumers[index]),
          `trial ${trial} assignment ${index} satisfies its range`))
    }
  }
  t.end()
})
