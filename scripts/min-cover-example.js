'use strict'

// Reproducible demonstration / acceptance check for the minimum version cover
// tool. Run with: node scripts/min-cover-example.js

const semver = require('../index.js')
const { satisfies, maxSatisfying, minCover } = semver

let failures = 0
const assert = (condition, message) => {
  if (condition) {
    console.log(`  ok - ${message}`)
  } else {
    failures++
    console.log(`  FAIL - ${message}`)
  }
}

// Build a candidate -> covered-consumer bit mask strictly through satisfies()
// (never by comparing range strings).
const coverageMasks = (versions, ranges, options) =>
  versions.map((version) => {
    let mask = 0
    ranges.forEach((range, index) => {
      if (satisfies(version, range, options)) {
        mask |= 1 << index
      }
    })
    return { version, mask }
  })

// Greedy variant 1: give every consumer its own highest satisfying version.
const perConsumerGreedy = (versions, ranges, options) => {
  const picked = new Set()
  ranges.forEach((range) => {
    picked.add(maxSatisfying(versions, range, options))
  })
  return [...picked]
}

// Greedy variant 2: repeatedly add the version covering the most consumers not
// yet covered (highest version wins ties).
const maxCoverageGreedy = (versions, ranges, options) => {
  const picked = []
  let remaining = (1 << ranges.length) - 1
  while (remaining) {
    let best = null
    for (const candidate of coverageMasks(versions, ranges, options)) {
      const gain = candidate.mask & remaining
      if (gain === 0) {
        continue
      }
      if (best === null ||
        popcount(gain) > popcount(best.mask & remaining) ||
        (popcount(gain) === popcount(best.mask & remaining) &&
          semver.compare(candidate.version, best.version) > 0)) {
        best = candidate
      }
    }
    if (best === null) {
      return null
    }
    picked.push(best.version)
    remaining &= ~best.mask
  }
  return picked
}

// Exhaustive check over every subset of the distinct coverage sets, which are
// exactly the equivalence groups the tool compresses to first.
const bruteForceMinCover = (versions, ranges, options) => {
  const groups = new Map()
  for (const candidate of coverageMasks(versions, ranges, options)) {
    if (candidate.mask !== 0 && !groups.has(candidate.mask)) {
      groups.set(candidate.mask, candidate.version)
    }
  }
  const candidates = [...groups.entries()]
    .map(([mask, version]) => ({ mask, version }))
    .sort((a, b) => semver.compare(b.version, a.version))
  const full = (1 << ranges.length) - 1
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
    picked.sort(semver.rcompare)
    if (best === null || picked.length < best.length ||
      (picked.length === best.length && lexGreater(picked, best))) {
      best = picked
    }
  }
  return best
}

const popcount = (value) => {
  let count = 0
  while (value) {
    count += value & 1
    value >>>= 1
  }
  return count
}

const lexGreater = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (b[i] === undefined) {
      return true
    }
    if (a[i] === undefined) {
      return false
    }
    const compared = semver.compare(a[i], b[i])
    if (compared !== 0) {
      return compared > 0
    }
  }
  return false
}

console.log('Example 1: three overlapping ranges')
{
  const ranges = ['^1.0.0', '~1.2.0', '1.2.3']
  const versions = ['1.5.0', '1.2.9', '1.2.3', '1.0.0']
  console.log(`  ranges:   ${JSON.stringify(ranges)}`)
  console.log(`  versions: ${JSON.stringify(versions)}`)
  console.log(`  coverage sets: ${JSON.stringify(
    coverageMasks(versions, ranges).map((c) => ({ ...c, mask: c.mask.toString(2) }))
  )}`)

  const greedy = perConsumerGreedy(versions, ranges)
  const exhaustive = bruteForceMinCover(versions, ranges)
  const result = minCover(ranges, versions)
  console.log(`  per-consumer greedy:  ${JSON.stringify(greedy)} (${greedy.length} versions)`)
  console.log(`  exhaustive minimum:   ${JSON.stringify(exhaustive)} (${exhaustive.length} versions)`)
  console.log(`  minCover versions:    ${JSON.stringify(result.versions)}`)
  console.log(`  minCover assignments: ${JSON.stringify(result.assignments)}`)

  assert(greedy.length === 3, 'greedy uses 3 versions (not optimal)')
  assert(exhaustive.length === 1, 'exhaustive enumeration finds a 1-version minimum')
  assert(result.versions.length === exhaustive.length,
    'minimum cover size matches exhaustive enumeration')
  assert(result.versions[0] === '1.2.3', 'the single shared version 1.2.3 is selected')
  ranges.forEach((range, index) =>
    assert(satisfies(result.assignments[index], range),
      `assignment ${index} ${result.assignments[index]} satisfies ${range}`))
}

console.log('')
console.log('Example 2: even max-coverage greedy is suboptimal')
{
  // vA covers c0-c3, vB covers {c0,c1,c4}, vC covers {c2,c3,c5}, vD/vE the
  // tails. vB + vC cover all 6 consumers (2); greedy commits to vA first and
  // then needs two more (3).
  const ranges = [
    '4.0.0 || 2.0.0', // c0
    '4.0.0 || 2.0.0', // c1
    '4.0.0 || 3.0.0', // c2
    '4.0.0 || 3.0.0', // c3
    '2.0.0 || 1.0.0', // c4
    '3.0.0 || 0.1.0', // c5
  ]
  const versions = ['4.0.0', '3.0.0', '2.0.0', '1.0.0', '0.1.0']
  const greedy = maxCoverageGreedy(versions, ranges)
  const exhaustive = bruteForceMinCover(versions, ranges)
  const result = minCover(ranges, versions)
  console.log(`  max-coverage greedy: ${JSON.stringify(greedy)} (${greedy.length} versions)`)
  console.log(`  exhaustive minimum:  ${JSON.stringify(exhaustive)} (${exhaustive.length} versions)`)
  console.log(`  minCover versions:   ${JSON.stringify(result.versions)}`)

  assert(greedy.length === 3, 'max-coverage greedy uses 3 versions')
  assert(exhaustive.length === 2, 'exhaustive enumeration finds a 2-version minimum')
  assert(result.versions.length === 2 &&
    result.versions[0] === '3.0.0' && result.versions[1] === '2.0.0',
  'minCover selects 3.0.0 + 2.0.0')
}

console.log('')
console.log('Example 3: equivalence compression by coverage set')
{
  const ranges = ['^1.0.0', '>=1.0.0 <2.0.0', '1.2.3']
  // Exact duplicates collapse; semver-equal builds collapse; first occurrence
  // of each coverage set is kept.
  const versions = ['1.2.3+b', '1.2.3+a', '1.2.3+b', '1.5.0', '9.0.0']
  const result = minCover(ranges, versions)
  console.log(`  versions: ${JSON.stringify(versions)}`)
  console.log(`  minCover versions: ${JSON.stringify(result.versions)}`)
  assert(result.versions.length === 1 && result.versions[0] === '1.2.3+b',
    'equivalent candidates compress to one group, first occurrence kept')
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed')
}
