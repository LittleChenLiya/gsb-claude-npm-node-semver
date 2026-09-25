'use strict'

const { test } = require('tap')
const Range = require('../../classes/range')
const RangeIndex = require('../../classes/range-index')

// brute-force reference: test every range individually, honoring each
// entry's own includePrerelease option
const reference = (entries, version) => entries
  .filter(e => e.rangeObj.test(version))
  .map(e => e.id)
  .sort()

const makeEntries = (list) => list.map(([id, range, options]) => ({
  id,
  range,
  options,
  rangeObj: new Range(range, options),
}))

const mixedEntries = makeEntries([
  // intersecting ranges
  ['overlap-a', '>=1.2.0 <2.0.0'],
  ['overlap-b', '>=1.5.0 <=3.0.0'],
  // OR range with a hole
  ['or-range', '^1.0.0 || >=3.0.0'],
  // prerelease-only range
  ['pre-only', '>=2.0.0-alpha <2.0.0', { includePrerelease: true }],
  // exact prerelease pin without includePrerelease
  ['pre-pin', '2.0.0-alpha.1'],
  // matches everything (release versions only, per default semantics)
  ['star', '*'],
  // exact version
  ['exact', '4.5.6'],
])

const boundaryVersions = [
  '1.1.9',
  '1.2.0',
  '1.2.0+build.7',
  '1.4.9',
  '1.5.0',
  '1.5.1',
  '2.0.0',
  '2.0.0-alpha',
  '2.0.0-alpha.1',
  '2.0.0-alpha.2',
  '2.0.0-0',
  '3.0.0',
  '3.0.1',
  '4.5.6',
  '4.5.6+meta',
  '4.5.7',
  '0.0.0',
  '10.0.0',
  '9.9.9',
]

test('boundary queries match one-by-one Range.test reference', t => {
  const idx = new RangeIndex(mixedEntries)
  for (const v of boundaryVersions) {
    t.same(idx.query(v), reference(mixedEntries, v),
      'query(' + v + ') matches reference')
  }
  t.end()
})

test('index does not sort versions lexicographically', t => {
  // '10.0.0' < '9.0.0' in string order, but 10.0.0 > 9.0.0 in semver
  const idx = new RangeIndex(makeEntries([
    ['nine-plus', '>=9.0.0'],
    ['ten-only', '>=10.0.0 <11.0.0'],
  ]))
  t.same(idx.query('10.0.0'), ['nine-plus', 'ten-only'])
  t.same(idx.query('9.5.0'), ['nine-plus'])
  t.end()
})

test('build metadata in query and range', t => {
  const idx = new RangeIndex(makeEntries([
    ['exact', '1.2.3'],
    ['with-build', '>=1.2.3+build.5 <2.0.0'],
    ['bounded', '<=1.2.3'],
  ]))
  t.same(idx.query('1.2.3+other.build'), ['bounded', 'exact', 'with-build'])
  t.same(idx.query('1.2.4+meta'), ['with-build'])
  t.end()
})

test('no match and invalid versions', t => {
  const idx = new RangeIndex(makeEntries([['a', '1.2.3']]))
  t.same(idx.query('9.9.9'), [], 'no matching ranges')
  t.same(idx.query('not a version'), [], 'invalid version string')
  t.same(idx.query(''), [], 'empty version')
  t.same(idx.query(null), [], 'null version')
  t.same(new RangeIndex().query('1.2.3'), [], 'empty index')
  t.end()
})

test('duplicate ids are rejected', t => {
  t.throws(() => new RangeIndex([
    { id: 'a', range: '1.x' },
    { id: 'a', range: '2.x' },
  ]), TypeError, 'duplicate id in constructor entries')

  const idx = new RangeIndex(makeEntries([['a', '1.x']]))
  t.throws(() => idx.add('a', '2.x'), TypeError, 'duplicate id in add()')
  t.throws(() => idx.update([
    { id: 'b', range: '2.x' },
    { id: 'b', range: '3.x' },
  ]), TypeError, 'duplicate id in update batch')
  t.same(idx.query('1.2.3'), ['a'], 'index unchanged after rejections')
  t.end()
})

test('failed update leaves index untouched (atomicity)', t => {
  const idx = new RangeIndex(mixedEntries)
  const probes = boundaryVersions.map(v => [v, idx.query(v)])

  t.throws(() => idx.update([
    { id: 'good', range: '>=1.0.0' },
    { id: 'bad', range: 'this is not a range!!' },
  ]), 'update with a bad range throws')

  t.throws(() => idx.replaceAll([
    { id: 'ok', range: '1.x' },
    { id: 'broken', range: '>=99999999999999999999.0.0' },
  ]), 'replaceAll with a bad range throws')

  for (const [v, expected] of probes) {
    t.same(idx.query(v), expected, 'query(' + v + ') unchanged after failed updates')
  }
  t.equal(idx.size, mixedEntries.length, 'no partial entries committed')
  t.notOk(idx.has('good'), 'valid entry from failed batch not committed')
  t.end()
})

test('delete and replace of the same id', t => {
  const idx = new RangeIndex(makeEntries([
    ['a', '>=1.0.0 <2.0.0'],
    ['b', '3.x'],
  ]))

  // replace an existing id in a batch
  idx.update([{ id: 'a', range: '>=5.0.0 <6.0.0' }])
  t.same(idx.query('1.5.0'), [], 'old range of replaced id gone')
  t.same(idx.query('5.5.0'), ['a'], 'new range of replaced id active')

  // delete and re-add the same id within one atomic batch
  idx.update([
    { id: 'a', delete: true },
    { id: 'a', range: '7.7.7' },
  ])
  t.same(idx.query('5.5.0'), [], 'deleted range not matched')
  t.same(idx.query('7.7.7'), ['a'], 're-added id matches new range')

  // plain delete
  t.ok(idx.delete('a'), 'delete returns true for existing id')
  t.notOk(idx.delete('a'), 'delete returns false for missing id')
  t.same(idx.query('7.7.7'), [], 'deleted id no longer matches')
  t.same(idx.query('3.0.1'), ['b'], 'other entries unaffected')
  t.end()
})

test('query results are snapshots that do not change with updates', t => {
  const idx = new RangeIndex(makeEntries([
    ['a', '1.x'],
    ['b', '1.2.x'],
  ]))
  const before = idx.query('1.2.3')
  const beforeCopy = before.slice()
  t.same(before, ['a', 'b'])

  idx.update([{ id: 'a', delete: true }, { id: 'c', range: '1.2.3' }])
  t.same(before, beforeCopy, 'previously returned array is not mutated')
  t.same(idx.query('1.2.3'), ['b', 'c'], 'new queries see the update')

  idx.replaceAll([{ id: 'z', range: '0.0.1' }])
  t.same(before, beforeCopy, 'snapshot survives replaceAll')
  t.end()
})

test('Range instances keep their own includePrerelease option', t => {
  const idx = new RangeIndex([
    { id: 'pre', range: new Range('>=1.0.0 <2.0.0', { includePrerelease: true }) },
    { id: 'no-pre', range: new Range('>=1.0.0 <2.0.0') },
  ])
  t.same(idx.query('1.5.0-beta.1'), ['pre'])
  t.same(idx.query('1.5.0'), ['no-pre', 'pre'])
  t.end()
})

test('100k ranges: Range.test call count stays bounded', t => {
  const N = 100000
  const entries = []
  for (let i = 0; i < N; i++) {
    // disjoint unit intervals, almost all far from the query point
    entries.push({ id: 'pkg-' + i, range: '>=' + i + '.0.0 <' + (i + 1) + '.0.0' })
  }
  entries.push({ id: 'wide', range: '>=40000.0.0 <60000.0.0' })
  entries.push({ id: 'star', range: '*' })
  entries.push({ id: 'pre', range: '>=50000.0.0-alpha <50001.0.0', options: { includePrerelease: true } })

  const idx = new RangeIndex(entries)
  t.equal(idx.size, N + 3)

  let calls = 0
  const origTest = Range.prototype.test
  Range.prototype.test = function (v) {
    calls++
    return origTest.call(this, v)
  }
  try {
    calls = 0
    const hits = idx.query('50000.1.2')
    t.same(hits, ['pkg-50000', 'pre', 'star', 'wide'], 'expected hits at 50000.1.2')
    t.ok(calls <= 10, 'Range.test called ' + calls + ' times (<= 10), not ' + (N + 3))

    calls = 0
    const edge = idx.query('99999.0.0')
    t.same(edge, ['pkg-99999', 'star'], 'expected hits at 99999.0.0')
    t.ok(calls <= 10, 'Range.test called ' + calls + ' times (<= 10) near the top edge')

    calls = 0
    const none = idx.query('200000.0.0')
    t.same(none, ['star'], 'only the star range matches far above all intervals')
    t.ok(calls <= 10, 'Range.test called ' + calls + ' times (<= 10) outside all intervals')

    calls = 0
    const pre = idx.query('50000.0.0-beta')
    // default-option ranges (even '*') reject prerelease versions;
    // only the includePrerelease entry matches
    t.same(pre, ['pre'], 'prerelease-only entry matches prerelease query')
    t.ok(calls <= 10, 'Range.test called ' + calls + ' times (<= 10) for prerelease query')
  } finally {
    Range.prototype.test = origTest
  }
  t.end()
})

test('randomized differential test against Range.test reference', t => {
  // deterministic PRNG so failures are reproducible
  let seed = 0xC0FFEE
  const rand = () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const int = (n) => Math.floor(rand() * n)

  const version = (allowPre) => {
    let v = int(12) + '.' + int(8) + '.' + int(10)
    if (allowPre && rand() < 0.3) {
      v += '-' + pick(['alpha', 'beta.1', 'rc.2', '0', 'x.y.z'])
    }
    if (rand() < 0.1) {
      v += '+build.' + int(100)
    }
    return v
  }

  const rangeString = () => {
    const kind = rand()
    const v = () => version(false)
    if (kind < 0.15) {
      return '*'
    }
    if (kind < 0.35) {
      return '>=' + v() + ' <' + v()
    }
    if (kind < 0.5) {
      return pick(['>', '>=', '<', '<=']) + version(true)
    }
    if (kind < 0.65) {
      return pick(['^', '~']) + v()
    }
    if (kind < 0.8) {
      return int(12) + '.' + pick(['x', '*']) + '.x'
    }
    if (kind < 0.9) {
      return version(true)
    }
    return '>=' + v() + ' <' + v() + ' || >=' + v()
  }

  for (let round = 0; round < 5; round++) {
    const entries = []
    for (let i = 0; i < 150; i++) {
      entries.push({
        id: 'r' + round + '-' + i,
        range: rangeString(),
        options: rand() < 0.3 ? { includePrerelease: true } : undefined,
      })
    }
    const refs = makeEntries(entries.map(e => [e.id, e.range, e.options]))
    const idx = new RangeIndex(entries)

    for (let q = 0; q < 200; q++) {
      const v = version(true)
      t.same(idx.query(v), reference(refs, v), 'round ' + round + ' query(' + v + ')')
    }

    // random atomic updates, re-verify afterwards
    const ops = []
    const batchIds = new Set()
    for (let i = 0; i < 20; i++) {
      const id = pick(refs).id
      if (batchIds.has(id)) {
        continue
      }
      batchIds.add(id)
      if (rand() < 0.5) {
        ops.push({ id, delete: true })
        refs.splice(refs.findIndex(e => e.id === id), 1)
      } else {
        const options = rand() < 0.3 ? { includePrerelease: true } : undefined
        const e = { id, range: rangeString(), options }
        ops.push(e)
        const at = refs.findIndex(x => x.id === id)
        const ne = { ...e, rangeObj: new Range(e.range, e.options) }
        if (at === -1) {
          refs.push(ne)
        } else {
          refs[at] = ne
        }
      }
    }
    idx.update(ops)
    for (let q = 0; q < 100; q++) {
      const v = version(true)
      t.same(idx.query(v), reference(refs, v), 'round ' + round + ' post-update query(' + v + ')')
    }
  }
  t.end()
})

test('misc api', t => {
  const idx = new RangeIndex(new Map([
    ['a', '1.x'],
    ['b', { range: '2.x', options: { includePrerelease: true } }],
  ]))
  t.equal(idx.size, 2)
  t.ok(idx.has('a'))
  t.ok(idx.get('b') instanceof Range)
  t.same(idx.ids(), ['a', 'b'])
  t.same(idx.query('2.0.0-rc.1'), ['b'], 'Map entry options honored')
  t.throws(() => new RangeIndex([{ id: '', range: '1.x' }]), TypeError, 'empty id rejected')
  t.throws(() => new RangeIndex([{ id: 'x' }]), TypeError, 'missing range rejected')
  t.end()
})
