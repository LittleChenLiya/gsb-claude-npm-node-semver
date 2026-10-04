'use strict'

const { test } = require('tap')
const planUpgrade = require('../../functions/plan-upgrade')
const { planUpgrade: fromIndex } = require('../../')

const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0']
const diamond = [
  ['1.0.0', '1.1.0'],
  ['1.1.0', '2.0.0'],
  ['1.0.0', '1.2.0'],
  ['1.2.0', '2.0.0'],
]

test('exported from the index as planUpgrade', t => {
  t.equal(fromIndex, planUpgrade)
  t.end()
})

test('forbidden 1.2.x selects the chain through 1.1.0', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '2.0.0',
    forbidden: ['1.2.x'],
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0', '1.1.0', '2.0.0'])
  t.equal(res.steps.length, 2)
  t.same(res.steps[0], {
    from: '1.0.0',
    to: '1.1.0',
    edge: { from: '1.0.0', to: '1.1.0' },
    edgeIndex: 0,
  })
  t.same(res.steps[1], {
    from: '1.1.0',
    to: '2.0.0',
    edge: { from: '1.1.0', to: '2.0.0' },
    edgeIndex: 1,
  })
  t.match(res.explanation, /1\.0\.0 -> 1\.1\.0/)
  t.match(res.explanation, /1\.1\.0 -> 2\.0\.0/)
  t.end()
})

test('same-length chains: lowest full version order wins', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '2.0.0',
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0', '1.1.0', '2.0.0'],
    'via 1.1.0, not 1.2.0, when both chains have 2 steps')
  t.end()
})

test('no declared direct edge means no jump to 2.0.0', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '2.0.0',
  })
  t.equal(res.steps.length, 2, 'two steps, never a direct jump')
  t.notOk(res.steps.some((s) => s.from === '1.0.0' && s.to === '2.0.0'))

  const cut = planUpgrade({
    versions,
    edges: [['1.0.0', '1.1.0']],
    from: '1.0.0',
    to: '2.0.0',
  })
  t.equal(cut.ok, false)
  t.equal(cut.reason, 'unreachable')
  t.same(cut.reachable, ['1.0.0', '1.1.0'])
  t.end()
})

test('cyclic edges terminate and still find the shortest chain', t => {
  const res = planUpgrade({
    versions,
    edges: [
      ...diamond,
      ['2.0.0', '1.0.0'],
      ['1.1.0', '1.0.0'],
      ['1.2.0', '1.1.0'],
    ],
    from: '1.0.0',
    to: '2.0.0',
    forbidden: ['1.2.x'],
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0', '1.1.0', '2.0.0'])
  t.end()
})

test('forbidden target is reported as target-forbidden', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '2.0.0',
    forbidden: ['2.0.0'],
  })
  t.equal(res.ok, false)
  t.equal(res.reason, 'target-forbidden')
  t.same(res.forbiddenTargets, ['2.0.0'])
  t.match(res.explanation, /forbidden/)
  t.end()
})

test('missing target is reported as no-target', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '^3.0.0',
  })
  t.equal(res.ok, false)
  t.equal(res.reason, 'no-target')
  t.end()
})

test('unknown start version is reported as no-start', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '0.9.0',
    to: '2.0.0',
  })
  t.equal(res.ok, false)
  t.equal(res.reason, 'no-start')
  t.end()
})

test('prerelease versions are not matched by ranges by default', t => {
  const pre = {
    versions: ['1.0.0', '2.0.0-beta.1'],
    edges: [['1.0.0', '2.0.0-beta.1']],
    from: '1.0.0',
    to: '2.x',
  }
  const def = planUpgrade(pre)
  t.equal(def.ok, false)
  t.equal(def.reason, 'no-target', '2.x does not match 2.0.0-beta.1 by default')

  const incl = planUpgrade({ ...pre, options: { includePrerelease: true } })
  t.equal(incl.ok, true)
  t.same(incl.chain, ['1.0.0', '2.0.0-beta.1'])
  t.end()
})

test('forbidden ranges do not match prereleases by default', t => {
  const pre = {
    versions: ['1.0.0', '1.2.4-alpha.1', '2.0.0'],
    edges: [
      ['1.0.0', '1.2.4-alpha.1'],
      ['1.2.4-alpha.1', '2.0.0'],
    ],
    from: '1.0.0',
    to: '2.0.0',
    forbidden: ['1.2.x'],
  }
  const def = planUpgrade(pre)
  t.equal(def.ok, true, '1.2.x does not forbid 1.2.4-alpha.1 by default')
  t.same(def.chain, ['1.0.0', '1.2.4-alpha.1', '2.0.0'])

  const incl = planUpgrade({ ...pre, options: { includePrerelease: true } })
  t.equal(incl.ok, false)
  t.equal(incl.reason, 'unreachable')
  t.same(incl.blockedByForbidden, ['1.2.4-alpha.1'])
  t.end()
})

test('zero-step plan when the start already satisfies the target', t => {
  const res = planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: '>=1.0.0',
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0'])
  t.same(res.steps, [])
  t.equal(res.target, '1.0.0')
  t.end()
})

test('target range may resolve to the lowest satisfying version', t => {
  const res = planUpgrade({
    versions,
    edges: [
      ['1.0.0', '1.1.0'],
      ['1.1.0', '1.2.0'],
      ['1.2.0', '2.0.0'],
    ],
    from: '1.0.0',
    to: '>=1.1.0',
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0', '1.1.0'], 'shortest chain to any target wins')
  t.equal(res.target, '1.1.0')
  t.end()
})

test('edges to unpublished versions are dead ends', t => {
  const res = planUpgrade({
    versions,
    edges: [
      ['1.0.0', '9.9.9'],
      ['9.9.9', '2.0.0'],
      ...diamond,
    ],
    from: '1.0.0',
    to: '2.0.0',
  })
  t.equal(res.ok, true)
  t.same(res.chain, ['1.0.0', '1.1.0', '2.0.0'])
  t.end()
})

test('object edges are accepted and reported in steps', t => {
  const res = planUpgrade({
    versions,
    edges: [
      { from: '1.0.0', to: '1.1.0' },
      { from: '1.1.0', to: '2.0.0' },
    ],
    from: '1.0.0',
    to: '2.0.0',
  })
  t.equal(res.ok, true)
  t.same(res.steps[0].edge, { from: '1.0.0', to: '1.1.0' })
  t.equal(res.steps[1].edgeIndex, 1)
  t.end()
})

test('invalid input throws', t => {
  t.throws(() => planUpgrade({ to: '2.0.0' }), TypeError, 'from is required')
  t.throws(() => planUpgrade({ from: '1.0.0' }), TypeError, 'to is required')
  t.throws(() => planUpgrade({
    versions,
    edges: [['1.0.0']],
    from: '1.0.0',
    to: '2.0.0',
  }), TypeError, 'malformed edge rejected')
  t.throws(() => planUpgrade({
    versions,
    edges: diamond,
    from: '1.0.0',
    to: 'not a range',
  }), 'invalid target range throws')
  t.end()
})
