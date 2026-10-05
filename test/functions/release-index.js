'use strict'

const { test } = require('tap')
const releaseIndex = require('../../functions/release-index')

test('build metadata variants share one precedence group', (t) => {
  const index = releaseIndex(['1.0.0+a', '1.0.0+b', '0.9.0', '2.0.0'])
  t.matchSnapshot(index.entries, 'index entries keep distinct build identities')
  t.same(
    index.entries.map((e) => e.version),
    ['0.9.0', '1.0.0+a', '1.0.0+b', '2.0.0'],
    'ordered by precedence, build metadata ignored for ordering'
  )
  t.same(index.entries[1].precedence, '1.0.0')
  t.same(index.entries[2].precedence, '1.0.0')
  t.end()
})

test('same precedence group keeps input order when input is reordered', (t) => {
  const ab = releaseIndex(['1.0.0+a', '1.0.0+b'])
  const ba = releaseIndex(['1.0.0+b', '1.0.0+a'])
  t.same(ab.entries.map((e) => e.version), ['1.0.0+a', '1.0.0+b'])
  t.same(ba.entries.map((e) => e.version), ['1.0.0+b', '1.0.0+a'])
  t.matchSnapshot(ba.entries, 'reordered input stays stable within group')
  t.end()
})

test('duplicate full versions merge and record every source position', (t) => {
  const index = releaseIndex(['1.0.0+a', '0.1.0', '1.0.0+a', '1.0.0+b'])
  const merged = index.entries.find((e) => e.version === '1.0.0+a')
  t.same(merged.sources, [0, 2], 'both source positions recorded')
  t.equal(
    index.entries.filter((e) => e.version === '1.0.0+a').length,
    1,
    'duplicate merged into a single entry'
  )
  t.matchSnapshot(index.entries, 'merged duplicate sources')
  t.end()
})

test('invalid version rejects the whole batch, no index produced', (t) => {
  t.throws(
    () => releaseIndex(['1.0.0+a', 'not-a-version', '2.0.0']),
    { message: 'Invalid version in release manifest at position 1: not-a-version' }
  )
  t.throws(() => releaseIndex('1.0.0+a'), TypeError)
  t.end()
})

test('range query returns all real build identities', (t) => {
  const index = releaseIndex(['1.0.0+b', '1.0.0+a', '1.2.0', '0.9.9', '2.0.0-rc.1'])
  t.same(
    index.query('1.0.0'),
    ['1.0.0+b', '1.0.0+a'],
    'exact precedence match returns every build identity'
  )
  t.same(
    index.query('^1.0.0'),
    ['1.0.0+b', '1.0.0+a', '1.2.0'],
    'range match ignores build metadata for comparison'
  )
  t.same(index.query('>=2.0.0'), [], 'prerelease of 2.0.0 not included')
  t.matchSnapshot(index.query('^1.0.0'), 'range query result')
  t.end()
})
