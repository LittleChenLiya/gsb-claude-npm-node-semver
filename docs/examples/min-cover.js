'use strict'

// Example: pick the smallest set of real versions covering every
// consumer range, using the minCover range utility.
//
// Run with: node docs/examples/min-cover.js

const minCover = require('../../ranges/min-cover')
const satisfies = require('../../functions/satisfies')
const maxSatisfying = require('../../ranges/max-satisfying')

// Three consumers with overlapping ranges.  A naive greedy pass that
// gives each uncovered consumer its highest satisfying version picks
// 2.0.0 for the first consumer and then still needs 1.5.0, while the
// single version 1.5.0 covers all three.
const versions = ['1.2.0', '1.5.0', '2.0.0']
const ranges = ['>=1.0.0', '~1.5.0', '>=1.0.0 <2.0.0']

// Greedy: walk consumers in order, and whenever one is not covered
// yet, add its highest satisfying version.
const greedy = (versionList, rangeList) => {
  const chosen = []
  for (const range of rangeList) {
    if (chosen.some(v => satisfies(v, range))) {
      continue
    }
    const pick = maxSatisfying(versionList, range)
    if (pick) {
      chosen.push(pick)
    }
  }
  return chosen
}

// Exhaustive check: try every subset of the candidate versions and
// record the smallest size that covers every consumer.
const bruteForceMinSize = (versionList, rangeList) => {
  let best = Infinity
  for (let bits = 0; bits < (1 << versionList.length); bits++) {
    const subset = versionList.filter((_, i) => bits & (1 << i))
    if (subset.length >= best) {
      continue
    }
    if (rangeList.every(r => subset.some(v => satisfies(v, r)))) {
      best = subset.length
    }
  }
  return best
}

const greedyPick = greedy(versions, ranges)
console.log('greedy pick       :', greedyPick.join(', '))

const result = minCover(versions, ranges)
console.log('minCover versions :', result.versions.join(', '))
ranges.forEach((range, i) => {
  console.log(`  consumer ${i} (${range}) -> ${result.assignments[i]}`)
})

const expected = bruteForceMinSize(versions, ranges)
console.log('exhaustive minimum:', expected)

if (greedyPick.length <= result.versions.length) {
  console.error('FAIL: expected the greedy pick to be suboptimal here')
  process.exit(1)
}
if (result.versions.length !== expected) {
  console.error('FAIL: minCover size does not match exhaustive search')
  process.exit(1)
}
ranges.forEach((range, i) => {
  if (!satisfies(result.assignments[i], range)) {
    console.error(`FAIL: assignment ${result.assignments[i]} does not satisfy ${range}`)
    process.exit(1)
  }
})
console.log('OK: minCover beats the greedy pick and matches exhaustive search')
