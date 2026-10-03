'use strict'

const { test } = require('tap')
const resolveTags = require('../../functions/resolve-tags')
const {
  MissingTagError,
  TagCycleError,
  VersionRangeError,
} = resolveTags

test('resolves stable -> release -> v1.2.3 in ^1.0.0, keeping the chain', t => {
  const manifest = {
    latest: 'v2.1.0',
    stable: 'release',
    release: 'v1.2.3',
  }
  const [result] = resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
  ])
  t.equal(result.tag, 'stable')
  t.same(result.chain, ['stable', 'release'])
  t.equal(result.version.raw, 'v1.2.3')
  t.equal(result.version.version, '1.2.3')
  t.end()
})

test('a missing tag fails the whole batch (atomic, no partial results)', t => {
  const manifest = {
    latest: 'v2.1.0',
    stable: 'release',
    release: 'v1.2.3',
    broken: 'nope',
  }
  const snapshot = JSON.parse(JSON.stringify(manifest))
  const err = t.throws(() => resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
    { tag: 'broken', range: '^1.0.0' },
  ]), MissingTagError)
  t.equal(err.code, 'EMISSINGTAG')
  t.equal(err.tag, 'nope')
  t.equal(err.referencedBy, 'broken')
  // the manifest is not mutated with resolved versions
  t.same(manifest, snapshot)
  t.end()
})

test('a missing starting tag is reported without a referrer', t => {
  const err = t.throws(() => resolveTags({}, [
    { tag: 'nope', range: '*' },
  ]), MissingTagError)
  t.equal(err.tag, 'nope')
  t.equal(err.referencedBy, null)
  t.end()
})

test('reports the cycle position for stable -> release -> stable', t => {
  const manifest = {
    stable: 'release',
    release: 'stable',
  }
  const err = t.throws(() => resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
  ]), TagCycleError)
  t.equal(err.code, 'ETAGCYCLE')
  t.same(err.chain, ['stable', 'release'])
  t.equal(err.cycleTag, 'stable')
  t.match(err.message, /stable -> release -> stable/)
  t.end()
})

test('reports a self-referencing tag as a cycle', t => {
  const manifest = { stable: 'stable' }
  const err = t.throws(() => resolveTags(manifest, [
    { tag: 'stable', range: '*' },
  ]), TagCycleError)
  t.same(err.chain, ['stable'])
  t.equal(err.cycleTag, 'stable')
  t.end()
})

test('errors when the resolved version does not satisfy the range', t => {
  const manifest = { stable: 'v2.0.0' }
  const err = t.throws(() => resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
  ]), VersionRangeError)
  t.equal(err.code, 'ENOTINRANGE')
  t.equal(err.version.version, '2.0.0')
  t.equal(err.range, '^1.0.0')
  t.end()
})

test('does not mutate the manifest (input unchanged)', t => {
  const manifest = {
    latest: 'v2.1.0',
    stable: 'release',
    release: 'v1.2.3',
  }
  const snapshot = JSON.parse(JSON.stringify(manifest))
  resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
    { tag: 'latest', range: '^2.0.0' },
  ])
  t.same(manifest, snapshot, 'manifest is unchanged after resolving')
  t.end()
})

test('duplicate requests resolve independently and identically', t => {
  const manifest = { stable: 'release', release: 'v1.2.3' }
  const results = resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
    { tag: 'stable', range: '^1.0.0' },
    { tag: 'release', range: '~1.2.0' },
  ])
  t.equal(results.length, 3)
  t.same(results[0], results[1])
  t.equal(results[2].tag, 'release')
  t.equal(results[2].version.version, '1.2.3')
  t.end()
})

test('prerelease versions need a prerelease in the range (SemVer precedence)', t => {
  const manifest = { next: 'v2.0.0-beta.1', beta: 'next' }

  // a prerelease version does not satisfy a release-only range ...
  t.throws(() => resolveTags(manifest, [
    { tag: 'next', range: '^2.0.0' },
  ]), VersionRangeError)

  // ... and includePrerelease alone does not lower the ^2.0.0 floor
  t.throws(() => resolveTags(manifest, [
    { tag: 'next', range: '^2.0.0' },
  ], { includePrerelease: true }), VersionRangeError)

  // a range naming the prerelease explicitly matches without any option
  const [result] = resolveTags(manifest, [
    { tag: 'beta', range: '^2.0.0-0' },
  ])
  t.equal(result.tag, 'beta')
  t.same(result.chain, ['beta', 'next'])
  t.equal(result.version.raw, 'v2.0.0-beta.1')
  t.equal(result.version.version, '2.0.0-beta.1')

  // includePrerelease lets a bare prerelease lower bound match too
  const [result2] = resolveTags(manifest, [
    { tag: 'next', range: '>=2.0.0-0' },
  ], { includePrerelease: true })
  t.equal(result2.version.version, '2.0.0-beta.1')
  t.end()
})

test('build metadata is ignored for range precedence but kept on the raw spelling', t => {
  const manifest = { stable: 'v1.2.3+build.99' }
  const [result] = resolveTags(manifest, [
    { tag: 'stable', range: '^1.0.0' },
  ])
  t.equal(result.version.raw, 'v1.2.3+build.99')
  // the canonical version is the package's normalized form (semver.valid)
  t.equal(result.version.version, '1.2.3')

  // build metadata never affects precedence: two builds of the same
  // version satisfy the same ranges even though neither outranks the other
  const [a] = resolveTags({ stable: '1.2.3+build.1' },
    [{ tag: 'stable', range: '^1.0.0' }])
  const [b] = resolveTags({ stable: '1.2.3+build.2' },
    [{ tag: 'stable', range: '^1.0.0' }])
  t.equal(a.version.version, '1.2.3')
  t.equal(b.version.version, '1.2.3')
  t.end()
})

test('invalid inputs throw TypeError', t => {
  t.throws(() => resolveTags(null, []), TypeError)
  t.throws(() => resolveTags({}, {}), TypeError)
  t.throws(() => resolveTags({}, [{ tag: 'stable' }]), TypeError)
  t.throws(() => resolveTags({}, [{ tag: 'stable', range: 'not a range' }]), TypeError)
  t.throws(() => resolveTags({ a: 5 }, [{ tag: 'a', range: '*' }]), TypeError)
  t.end()
})
