'use strict'

const { test } = require('tap')
const manifest = require('../../functions/manifest')
const SemVer = require('../../classes/semver')

test('sorts by precedence and keeps build metadata identities', (t) => {
  const idx = manifest(['2.0.0', '1.0.0+b', '1.0.0+a', '1.0.0'])

  t.same(idx.versions, [
    '1.0.0+b',
    '1.0.0+a',
    '1.0.0',
    '2.0.0',
  ], 'entries are sorted by precedence, with the group in original input order')

  t.equal(idx.length, 4)
  t.same(idx.entries.map(e => e.sources), [
    [1],
    [2],
    [3],
    [0],
  ], 'source positions follow the sorted entries')
  t.end()
})

test('1.0.0+a and 1.0.0+b are distinct identities in the same precedence group', (t) => {
  const idx = manifest(['1.0.0+a', '1.0.0+b'])

  t.equal(idx.length, 2)
  t.same(idx.versions, ['1.0.0+a', '1.0.0+b'])
  t.equal(idx.entries[0].version.compare(idx.entries[1].version), 0,
    'build metadata does not affect precedence')
  t.not(idx.entries[0].version.raw, idx.entries[1].version.raw,
    'the two full versions are distinct identities')
  t.end()
})

test('entries in the same precedence group keep their original input order', (t) => {
  // Reversing the input must reverse the order inside the group, while the
  // group itself stays in its precedence position.
  const a = manifest(['1.0.0+a', '1.0.0+b', '2.0.0']).versions
  const b = manifest(['2.0.0', '1.0.0+b', '1.0.0+a']).versions

  t.same(a, ['1.0.0+a', '1.0.0+b', '2.0.0'])
  t.same(b, ['1.0.0+b', '1.0.0+a', '2.0.0'])
  t.end()
})

test('duplicate full versions merge sources without losing any position', (t) => {
  const idx = manifest(['1.0.0+a', '2.0.0', '1.0.0+a', '1.0.0+b', '2.0.0'])

  t.same(idx.versions, ['1.0.0+a', '1.0.0+b', '2.0.0'])
  t.same(idx.entries.map(e => e.sources), [
    [0, 2],
    [3],
    [1, 4],
  ], 'every source position is remembered in input order')
  t.end()
})

test('an invalid version rejects the whole batch and produces no index', (t) => {
  t.throws(() => manifest(['1.0.0', 'nope', '2.0.0']),
    /Invalid version at index 1/, 'the offending position is reported')
  t.throws(() => manifest(['nope']), /Invalid version at index 0/)
  t.throws(() => manifest(['1.0.0', 42]), /Invalid version at index 1/)
  t.throws(() => manifest('1.0.0'), /Manifest expects an array/)

  // A valid batch after an invalid one still works: nothing is cached or
  // partially produced.
  t.same(manifest(['1.0.0', '2.0.0']).versions, ['1.0.0', '2.0.0'])
  t.end()
})

test('range queries return every real version identity', (t) => {
  const idx = manifest(['1.0.0+a', '1.0.0+b', '1.5.0', '2.0.0', '2.0.0+build'])

  t.same(idx.range('1.x').map(e => e.raw), [
    '1.0.0+a',
    '1.0.0+b',
    '1.5.0',
  ], '1.x returns all 1.x identities including build variants')

  t.same(idx.range('2.x').map(e => e.raw), [
    '2.0.0',
    '2.0.0+build',
  ], '2.x returns both identities')

  t.same(idx.satisfies('~1.0.0').map(e => e.raw), [
    '1.0.0+a',
    '1.0.0+b',
  ], 'satisfies() is an alias for range()')
  t.end()
})

test('build metadata is never used for range comparison', (t) => {
  const idx = manifest(['1.0.0+a', '1.0.0+b'])

  t.same(idx.range('1.0.0').map(e => e.raw), ['1.0.0+a', '1.0.0+b'],
    'range without build matches both build variants')
  t.same(idx.range('1.0.0+a').map(e => e.raw), ['1.0.0+a', '1.0.0+b'],
    'range with build metadata still matches by precedence only')
  t.end()
})

test('range queries can take multiple ranges', (t) => {
  const idx = manifest(['1.0.0', '1.5.0', '2.0.0', '3.0.0'])

  t.same(idx.range(['>=1.0.0', '<2.0.0']).map(e => e.raw), [
    '1.0.0',
    '1.5.0',
  ])
  t.end()
})

test('works with SemVer instances and loose parsing', (t) => {
  const idx = manifest([new SemVer('1.0.0'), '2.0.0'], { loose: true })
  t.same(idx.versions, ['1.0.0', '2.0.0'])

  const loose = manifest(['v1.0.0', '2.0.0'], { loose: true })
  t.same(loose.versions, ['1.0.0', '2.0.0'])
  t.end()
})

test('is iterable and exposes the Manifest class', (t) => {
  const { Manifest, ManifestEntry } = manifest
  t.type(Manifest, 'function')
  t.type(ManifestEntry, 'function')

  const idx = new Manifest(['1.0.0', '2.0.0'])
  t.same([...idx].map(e => e.raw), ['1.0.0', '2.0.0'])
  t.end()
})
