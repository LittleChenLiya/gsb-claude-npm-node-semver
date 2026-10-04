'use strict'

const assert = require('assert')
const planUpgrade = require('../../functions/plan-upgrade')

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log('ok - ' + name)
}

const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0']
const edges = [
  ['1.0.0', '1.1.0'],
  ['1.0.0', '1.2.0'],
  ['1.1.0', '2.0.0'],
  ['1.2.0', '2.0.0'],
]

test('1. two two-step paths: same-length tie-break picks via 1.1.0', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '2.0.0', [])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0', '2.0.0'])
  assert.equal(res.steps.length, 2)
  assert.deepEqual(res.steps[0].edge, ['1.0.0', '1.1.0'])
  assert.deepEqual(res.steps[1].edge, ['1.1.0', '2.0.0'])
})

test('2. disabling 1.2.x keeps the via-1.1.0 chain', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '2.0.0', ['1.2.x'])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0', '2.0.0'])
})

test('3. no direct edge: cannot jump to 2.0.0 in one step', () => {
  const noDirect = [
    ['1.0.0', '1.2.0'],
    ['1.2.0', '2.0.0'],
  ]
  const res = planUpgrade(versions, noDirect, '1.0.0', '2.0.0', [])
  assert.equal(res.ok, true)
  assert.equal(res.steps.length, 2, 'must not jump to 2.0.0 without a direct edge')
  assert.deepEqual(res.path, ['1.0.0', '1.2.0', '2.0.0'])
})

test('4. no path at all to 2.0.0 is blocked, not a jump', () => {
  const deadEnd = [['1.0.0', '1.2.0']]
  const res = planUpgrade(versions, deadEnd, '1.0.0', '2.0.0', [])
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'blocked')
})

test('5. prerelease versions are not matched by default', () => {
  const preVersions = ['1.0.0', '1.2.0-beta.1']
  const preEdges = [['1.0.0', '1.2.0-beta.1']]
  // >1.0.0 <2.0.0 has no prerelease comparator: default semantics do not
  // match the prerelease, so no target exists.
  let res = planUpgrade(preVersions, preEdges, '1.0.0', '>1.0.0 <2.0.0', [])
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no-target')
  // An explicit prerelease comparator of the same tuple does match.
  res = planUpgrade(preVersions, preEdges, '1.0.0', '>=1.2.0-beta.0 <2.0.0', [])
  assert.equal(res.ok, true)
  assert.equal(res.target, '1.2.0-beta.1')
  // includePrerelease opts in for the same range.
  res = planUpgrade(preVersions, preEdges, '1.0.0', '>1.0.0 <2.0.0', [], { includePrerelease: true })
  assert.equal(res.ok, true)
  assert.equal(res.target, '1.2.0-beta.1')
})

test('6. disabled ranges do not silently swallow prereleases either', () => {
  const preVersions = ['1.0.0', '1.2.0-beta.1', '1.2.0']
  const preEdges = [
    ['1.0.0', '1.2.0-beta.1'],
    ['1.0.0', '1.2.0'],
  ]
  // ^1.2.0 disables 1.2.0 but not 1.2.0-beta.1 (default semantics).
  const res = planUpgrade(preVersions, preEdges, '1.0.0', '>=1.2.0-beta.0 <2.0.0', ['^1.2.0'])
  assert.equal(res.ok, true)
  assert.equal(res.target, '1.2.0-beta.1')
})

test('7. cycle edges terminate and still find the shortest chain', () => {
  const cyclic = [
    ['1.0.0', '1.1.0'],
    ['1.1.0', '1.0.0'],
    ['1.1.0', '1.2.0'],
  ]
  const res = planUpgrade(versions.slice(0, 3), cyclic, '1.0.0', '1.2.0', [])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0', '1.2.0'])
})

test('8. same-length tie-break: diamond via 1.1.0', () => {
  const diamond = [
    ['1.0.0', '1.1.0'],
    ['1.0.0', '1.2.0'],
    ['1.1.0', '1.3.0'],
    ['1.2.0', '1.3.0'],
  ]
  const res = planUpgrade(
    ['1.0.0', '1.1.0', '1.2.0', '1.3.0'],
    diamond, '1.0.0', '>=1.3.0 <2.0.0', [])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0', '1.3.0'])
})

test('9. one-step tie-break picks the smaller target', () => {
  const fork = [
    ['1.0.0', '1.1.0'],
    ['1.0.0', '1.2.0'],
  ]
  const res = planUpgrade(versions.slice(0, 3), fork, '1.0.0', '>1.0.0 <2.0.0', [])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0'])
})

test('10. disabled endpoint is blocked', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '2.0.0', ['2.0.0'])
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'blocked')
})

test('11. disabled intermediate reroutes to the other two-step path', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '2.0.0', ['1.1.0'])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.2.0', '2.0.0'])
})

test('12. no published version satisfies the target range', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '^3.0.0', [])
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no-target')
})

test('13. target exists but is unreachable is blocked', () => {
  const local = [['1.0.0', '1.1.0']]
  const res = planUpgrade(versions, local, '1.0.0', '2.0.0', [])
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'blocked')
})

test('14. zero-step when start already satisfies the target', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '^1.0.0', [])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0'])
  assert.equal(res.steps.length, 0)
})

test('15. a disabled start may be left but not ended on', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '1.1.0', ['1.0.0'])
  assert.equal(res.ok, true)
  assert.deepEqual(res.path, ['1.0.0', '1.1.0'])
  const blocked = planUpgrade(versions, edges, '1.0.0', '^1.0.0', ['1.0.0'])
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'blocked')
})

test('16. invalid inputs throw', () => {
  assert.throws(() => planUpgrade(['nope'], [], '1.0.0', '^1.0.0', []), /Invalid version/)
  assert.throws(() => planUpgrade(versions, [], 'nope', '^1.0.0', []), /Invalid start version/)
  assert.throws(() => planUpgrade(versions, [], '9.9.9', '^1.0.0', []), /not a published version/)
  assert.throws(() => planUpgrade(versions, [['1.0.0', 'nope']], '1.0.0', '^1.0.0', []), /Invalid edge version/)
  assert.throws(() => planUpgrade(versions, [['9.9.9', '1.0.0']], '1.0.0', '^1.0.0', []), /not a published version/)
  assert.throws(() => planUpgrade(versions, edges, '1.0.0', 'blerg', []), /Invalid target range/)
  assert.throws(() => planUpgrade(versions, edges, '1.0.0', '^1.0.0', ['blerg']), /Invalid disabled range/)
})

test('17. explanation example', () => {
  const res = planUpgrade(versions, edges, '1.0.0', '2.0.0', ['1.2.x'])
  assert.equal(res.ok, true)
  console.log('--- 规划解释示例 ---')
  console.log(res.explanation)
  res.steps.forEach(s => console.log(s.text))
  console.log('------------------')
})

console.log('\nAll ' + passed + ' planner tests passed')
