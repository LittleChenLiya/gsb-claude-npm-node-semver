'use strict'

const { test } = require('tap')
const Range = require('../../classes/range')
const RangeIndex = require('../../classes/range-index')
const SemVer = require('../../classes/semver')

// brute-force reference: exactly what逐一 Range.test would say
const reference = (entries, version) => entries
  .filter(e => new Range(e.range, e.options).test(version))
  .map(e => e.id)
  .sort()

const fixture = () => [
  { id: 'caret', range: '^1.2.3' },
  { id: 'tilde', range: '~1.2.0' },
  { id: 'or', range: '^1.0.0 || >=2.0.0 <2.5.0' },
  { id: 'intersect-a', range: '>=1.0.0 <2.0.0' },
  { id: 'intersect-b', range: '>=1.5.0 <3.0.0' },
  { id: 'pre-only',
    range: '>=1.3.0-alpha.1 <1.3.0',
    options: { includePrerelease: true } },
  { id: 'pre-strict', range: '>=1.3.0-alpha.1 <1.3.0' },
  { id: 'exact', range: '1.2.3' },
  { id: 'star', range: '*' },
  { id: 'hyphen', range: '1.0.0 - 1.2.0' },
  { id: 'loose', range: '>=01.02.03', options: { loose: true } },
]

test('boundary queries match逐一 Range.test reference set', t => {
  const entries = fixture()
  const index = new RangeIndex(entries)
  const versions = [
    '0.0.0', '0.9.9', '1.0.0', '1.1.9', '1.2.0', '1.2.2', '1.2.3',
    '1.2.4', '1.3.0-alpha.1', '1.3.0-alpha.2', '1.3.0-beta', '1.3.0',
    '1.4.0', '1.5.0', '1.9.9', '2.0.0', '2.4.9', '2.5.0', '2.5.1',
    '3.0.0', '10.0.0', '1.2.3-alpha', '2.0.0-alpha', '1.2.0-alpha',
  ]
  t.plan(versions.length)
  for (const v of versions) {
    t.same(index.query(v), reference(entries, v), `query ${v}`)
  }
})

test('query accepts SemVer objects and unparseable versions', t => {
  const entries = fixture()
  const index = new RangeIndex(entries)
  t.same(index.query(new SemVer('1.2.3')), reference(entries, '1.2.3'),
    'SemVer instance query')
  t.same(index.query('not a version'), [], 'invalid version matches nothing')
  t.same(index.query(''), [], 'empty version matches nothing')
  t.same(index.query(null), [], 'null version matches nothing')
  const looseIdx = new RangeIndex([
    { id: 'loose-low', range: '<2.0.0', options: { loose: true } },
    { id: 'strict-low', range: '<2.0.0' },
  ])
  // '01.5.0' only parses in loose mode; per-range options decide the
  // outcome, exactly as逐一 Range.test would
  t.same(looseIdx.query('01.5.0'), ['loose-low'],
    'loose-only version keeps per-range parse semantics')
  t.end()
})

test('duplicate ids are rejected', t => {
  t.throws(() => new RangeIndex([
    { id: 'a', range: '1.x' },
    { id: 'a', range: '2.x' },
  ]), 'duplicate id in constructor entries')
  const index = new RangeIndex([{ id: 'a', range: '1.x' }])
  t.throws(() => index.update({ set: [{ id: 'a', range: '2.x' }] }),
    'duplicate id against existing entry')
  t.throws(() => index.update({ set: [
    { id: 'b', range: '2.x' },
    { id: 'b', range: '3.x' },
  ] }), 'duplicate id within one batch')
  t.throws(() => index.update({ delete: ['a', 'a'] }),
    'duplicate id in delete list')
  t.same(index.ids(), ['a'], 'rejected updates changed nothing')
  t.end()
})

test('bad range in a batch rejects the whole update atomically', t => {
  const index = new RangeIndex([
    { id: 'a', range: '^1.0.0' },
    { id: 'b', range: '^2.0.0' },
  ])
  const before1 = index.query('1.5.0')
  const before2 = index.query('2.5.0')
  t.throws(() => index.update({
    delete: ['a'],
    set: [
      { id: 'c', range: '^3.0.0' },
      { id: 'bad', range: 'not a range' },
    ],
  }), TypeError, 'invalid range aborts the batch')
  t.ok(index.has('a'), 'delete was not applied')
  t.notOk(index.has('c'), 'set was not applied')
  t.same(index.ids(), ['a', 'b'], 'index membership unchanged')
  // re-query after the failed update to verify results are stable
  t.same(index.query('1.5.0'), before1, 'query results unchanged (1.5.0)')
  t.same(index.query('2.5.0'), before2, 'query results unchanged (2.5.0)')
  t.end()
})

test('delete and replace of the same id in one batch', t => {
  const index = new RangeIndex([
    { id: 'a', range: '^1.0.0' },
    { id: 'b', range: '^2.0.0' },
  ])
  index.update({
    delete: ['a'],
    set: [{ id: 'a', range: '^3.0.0' }],
  })
  t.same(index.query('1.5.0'), [], 'old range no longer matches')
  t.same(index.query('3.1.0'), ['a'], 'new range matches')
  t.same(index.query('2.5.0'), ['b'], 'other entries untouched')
  index.update({ delete: ['b'] })
  t.same(index.query('2.5.0'), [], 'plain delete works')
  t.same(index.ids(), ['a'], 'only expected ids remain')
  t.end()
})

test('no match returns an empty array', t => {
  const index = new RangeIndex([
    { id: 'a', range: '^1.0.0' },
    { id: 'b', range: '~2.3.0' },
  ])
  t.same(index.query('9.9.9'), [], 'nothing matches 9.9.9')
  t.same(index.query('1.5.0-pre'), [], 'prerelease outside opt-in')
  t.same(new RangeIndex().query('1.0.0'), [], 'empty index matches nothing')
  t.end()
})

test('build metadata on versions and ranges', t => {
  const entries = [
    { id: 'exact', range: '1.2.3' },
    { id: 'bounded', range: '>=1.0.0 <2.0.0' },
    { id: 'high', range: '>=2.0.0' },
    { id: 'meta', range: '>=1.0.0+ignored <2.0.0' },
  ]
  const index = new RangeIndex(entries)
  const versions = ['1.2.3+build.5', '1.2.4+ci.7', '2.0.0+build', '0.9.0+x']
  t.plan(versions.length)
  for (const v of versions) {
    t.same(index.query(v), reference(entries, v), `query ${v}`)
  }
})

test('query results are snapshots, unaffected by later updates', t => {
  const index = new RangeIndex([
    { id: 'a', range: '^1.0.0' },
    { id: 'b', range: '^1.0.0' },
  ])
  const snapshot = index.query('1.5.0')
  const expected = [...snapshot]
  index.update({ delete: ['a', 'b'], set: [{ id: 'c', range: '*' }] })
  t.same(snapshot, expected, 'old result array did not change')
  t.same(index.query('1.5.0'), ['c'], 'index reflects the update')
  t.not(index.query('1.5.0'), index.query('1.5.0'),
    'each query returns a fresh array')
  t.end()
})

test('100k ranges: candidate filtering bounds Range.test calls', t => {
  // majors 0..99999 make semver precedence order differ from string
  // order ('10.0.0' < '2.0.0' as strings), and put most intervals far
  // from the query points
  const N = 100000
  const entries = []
  for (let i = 0; i < N; i++) {
    entries.push({ id: 'pkg-' + i, range: `>=${i}.0.0 <${i}.1.0` })
  }
  const index = new RangeIndex(entries)
  t.equal(index.size, N, 'all ranges indexed')

  const originalTest = Range.prototype.test
  let calls = 0
  Range.prototype.test = function (v) {
    calls++
    return originalTest.call(this, v)
  }
  try {
    t.same(index.query('50000.0.5'), ['pkg-50000'], 'hit in the middle')
    t.ok(calls <= 10, `middle query used ${calls} Range.test calls (<= 10)`)
    calls = 0
    t.same(index.query('50000.2.0'), [], 'gap between intervals')
    t.equal(calls, 0, 'no Range.test calls when no interval matches')
    calls = 0
    t.same(index.query('99999.0.0'), ['pkg-99999'], 'hit at the top edge')
    t.ok(calls <= 10, `edge query used ${calls} Range.test calls (<= 10)`)
    calls = 0
    t.same(index.query('0.0.5'), ['pkg-0'], 'hit at the bottom edge')
    t.ok(calls <= 10, `bottom query used ${calls} Range.test calls (<= 10)`)
  } finally {
    Range.prototype.test = originalTest
  }
  t.end()
})

test('randomized differential test against Range.test reference', t => {
  // deterministic prng so failures reproduce
  const mulberry32 = (seed) => () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
  const rand = mulberry32(20261001)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const int = (n) => Math.floor(rand() * n)
  const pre = () => pick(['', '', '', '-alpha', '-alpha.1', '-beta.2', '-rc.1'])
  const ver = () => `${int(6)}.${int(10)}.${int(10)}${pre()}`
  const template = () => {
    switch (int(7)) {
      case 0: return `^${ver()}`
      case 1: return `~${ver()}`
      case 2: return `${int(6)}.${int(10)}.x`
      case 3: return `>=${ver()} <${int(6)}.${int(10)}.${int(10)}`
      case 4: return `${ver()} - ${ver()}`
      case 5: return `${ver()} || ${ver()}`
      default: return ver()
    }
  }
  const entries = []
  for (let i = 0; i < 300; i++) {
    const entry = { id: 'r' + i, range: template() }
    if (rand() < 0.3) {
      entry.options = { includePrerelease: true }
    } else if (rand() < 0.1) {
      entry.options = { loose: true }
    }
    entries.push(entry)
  }
  const index = new RangeIndex(entries)
  const versions = []
  for (let i = 0; i < 500; i++) {
    versions.push(ver() + (rand() < 0.1 ? '+build.' + int(100) : ''))
  }
  t.plan(versions.length)
  for (const v of versions) {
    t.same(index.query(v), reference(entries, v), `differential ${v}`)
  }
})

test('randomized differential across updates', t => {
  const index = new RangeIndex()
  const live = new Map()
  let seq = 0
  const versions = ['1.0.0', '1.5.0-pre', '2.0.0', '2.5.5', '3.0.0-rc.1']
  for (let round = 0; round < 20; round++) {
    const batch = { set: [], delete: [] }
    for (const id of live.keys()) {
      if ((round + id.length) % 3 === 0) {
        batch.delete.push(id)
        live.delete(id)
      }
    }
    for (let i = 0; i < 5; i++) {
      const id = 'g' + round + '-' + i + '-' + seq++
      const entry = {
        id,
        range: `>=${round}.0.0 <${round + 2}.0.0`,
        options: i % 2 ? { includePrerelease: true } : undefined,
      }
      batch.set.push(entry)
      live.set(id, entry)
    }
    index.update(batch)
    const entries = [...live.values()]
    for (const v of versions) {
      t.same(index.query(v), reference(entries, v),
        `round ${round} query ${v}`)
    }
  }
  t.end()
})
