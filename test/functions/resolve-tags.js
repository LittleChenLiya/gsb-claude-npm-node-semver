'use strict'

const { test } = require('tap')
const resolveTags = require('../../functions/resolve-tags')
const compare = require('../../functions/compare')

const manifest = {
  latest: 'stable',
  stable: 'release',
  release: 'v1.2.3',
  beta: '1.3.0-beta.1',
}

test('resolves a tag chain to a locked version', t => {
  const [locked] = resolveTags(manifest, ['stable'], '^1.0.0')
  t.equal(locked.tag, 'stable')
  t.strictSame([...locked.chain], ['stable', 'release', 'v1.2.3'],
    'chain preserves the traversed tags and the raw version')
  t.equal(locked.raw, 'v1.2.3', 'raw version as written in the manifest')
  t.equal(locked.version, '1.2.3', 'canonical version')
  t.end()
})

test('resolves multiple requests in request order', t => {
  const results = resolveTags(manifest, ['latest', 'beta'], '^1.0.0 || >=1.3.0-beta.1 <2.0.0')
  t.equal(results.length, 2)
  t.strictSame([...results[0].chain], ['latest', 'stable', 'release', 'v1.2.3'])
  t.equal(results[0].version, '1.2.3')
  t.strictSame([...results[1].chain], ['beta', '1.3.0-beta.1'])
  t.equal(results[1].version, '1.3.0-beta.1')
  t.end()
})

test('a single missing tag fails the whole batch', t => {
  t.throws(
    () => resolveTags(manifest, ['stable', 'missing'], '^1.0.0'),
    { code: 'ETAGMISSING', tag: 'missing' },
    'no locked results are returned when any request fails'
  )
  t.end()
})

test('missing tag mid-chain reports the chain walked so far', t => {
  const er = t.throws(() => resolveTags({ a: 'b', b: 'ghost' }, ['a'], '*'))
  t.equal(er.code, 'ETAGMISSING')
  t.equal(er.tag, 'ghost')
  t.strictSame(er.chain, ['a', 'b', 'ghost'],
    'chain shows every tag reference that was followed')
  t.end()
})

test('tag cycles report the cycle position', t => {
  const er = t.throws(
    () => resolveTags({ stable: 'release', release: 'stable' }, ['stable'], '^1.0.0'))
  t.equal(er.code, 'ETAGCYCLE')
  t.strictSame(er.cycle, ['stable', 'release', 'stable'],
    'cycle shows where the chain closes the loop')
  t.equal(er.cycleStart, 0, 'position in the chain where the cycle starts')
  t.match(er.message, /stable -> release -> stable/)
  t.end()
})

test('self-referencing tag is a cycle', t => {
  const er = t.throws(() => resolveTags({ stable: 'stable' }, ['stable'], '*'))
  t.equal(er.code, 'ETAGCYCLE')
  t.strictSame(er.cycle, ['stable', 'stable'])
  t.equal(er.cycleStart, 0)
  t.end()
})

test('resolved version outside the allowed range fails the batch', t => {
  const er = t.throws(() => resolveTags(manifest, ['stable'], '^2.0.0'))
  t.equal(er.code, 'ETAGRANGE')
  t.equal(er.version, '1.2.3')
  t.equal(er.raw, 'v1.2.3')
  t.equal(er.range, '^2.0.0')
  t.strictSame(er.chain, ['stable', 'release', 'v1.2.3'])
  t.end()
})

test('input manifest is not mutated into a version cache', t => {
  const frozen = Object.freeze({
    latest: 'stable',
    stable: 'release',
    release: 'v1.2.3',
  })
  const before = JSON.stringify(frozen)
  const [locked] = resolveTags(frozen, ['latest'], '^1.0.0')
  t.equal(locked.version, '1.2.3')
  t.equal(JSON.stringify(frozen), before, 'manifest values are unchanged')
  t.strictSame(frozen, {
    latest: 'stable',
    stable: 'release',
    release: 'v1.2.3',
  }, 'tags were not replaced by cached versions')
  t.end()
})

test('duplicate requests resolve consistently', t => {
  const results = resolveTags(manifest, ['stable', 'latest', 'stable'], '^1.0.0')
  t.equal(results.length, 3)
  t.equal(results[0], results[2], 'same tag yields the same locked result')
  t.strictSame(results[0], results[2])
  t.equal(results[1].tag, 'latest')
  t.equal(results[1].version, '1.2.3')
  t.end()
})

test('prerelease versions need an opting range', t => {
  const [ok] = resolveTags(manifest, ['beta'], '>=1.3.0-beta.1 <2.0.0')
  t.equal(ok.version, '1.3.0-beta.1')

  const er = t.throws(() => resolveTags(manifest, ['beta'], '^1.0.0'))
  t.equal(er.code, 'ETAGRANGE',
    'prerelease not matched by a range without a prerelease comparator')

  const [optIn] = resolveTags(manifest, ['beta'], '^1.0.0', { includePrerelease: true })
  t.equal(optIn.version, '1.3.0-beta.1', 'includePrerelease option is honored')
  t.end()
})

test('build metadata is kept but never decides precedence', t => {
  const builds = {
    a: '1.2.3+build.1',
    b: '1.2.3+build.2',
    older: '1.2.2',
  }
  const results = resolveTags(builds, ['older', 'a', 'b'], '^1.0.0')
  t.equal(results[1].raw, '1.2.3+build.1', 'raw keeps the original writing')
  t.equal(results[1].version, '1.2.3',
    'canonical version drops build metadata, like valid()')
  t.equal(results[2].raw, '1.2.3+build.2')
  t.equal(compare(results[1].version, results[2].version), 0,
    'versions differing only in build metadata have equal precedence')
  t.equal(resolveTags.highest(results), results[1],
    'highest precedence follows SemVer: build metadata is ignored, ' +
    'earliest of the equal-precedence versions wins')
  t.equal(resolveTags.highest([results[0], results[1]]), results[1],
    'real precedence differences still win')
  t.end()
})

test('raw and canonical versions are both reported', t => {
  const [vtag] = resolveTags({ v: 'v2.0.0' }, ['v'], '>=2.0.0')
  t.equal(vtag.raw, 'v2.0.0')
  t.equal(vtag.version, '2.0.0')
  const [built] = resolveTags({ b: '1.0.0+sha.abc' }, ['b'], '1.0.0')
  t.equal(built.raw, '1.0.0+sha.abc')
  t.equal(built.version, '1.0.0', 'canonical form follows valid()')
  t.end()
})

test('tag values must be another tag or a full valid version', t => {
  const er = t.throws(() => resolveTags({ a: 123 }, ['a'], '*'))
  t.equal(er.code, 'ETAGINVALID')
  // a partial version is not a terminal version, so it is treated as a
  // tag reference, which is missing here
  const er2 = t.throws(() => resolveTags({ a: '1.2' }, ['a'], '*'))
  t.equal(er2.code, 'ETAGMISSING')
  t.equal(er2.tag, '1.2')
  t.end()
})

test('invalid inputs throw', t => {
  t.throws(() => resolveTags(null, ['a'], '*'), TypeError)
  t.throws(() => resolveTags(manifest, ['stable'], 'not a range'))
  t.throws(() => resolveTags(manifest, [42], '*'), TypeError)
  t.end()
})

test('a single tag string is accepted as a batch of one', t => {
  const results = resolveTags(manifest, 'stable', '^1.0.0')
  t.equal(results.length, 1)
  t.equal(results[0].version, '1.2.3')
  t.end()
})
