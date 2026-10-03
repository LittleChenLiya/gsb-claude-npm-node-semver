'use strict'

const { test } = require('tap')
const classify = require('../../functions/classify')
const { TYPES, DIRECTIONS } = classify

test('classifies build-only changes', (t) => {
  const res = classify('1.2.3+one', '1.2.3+two')
  t.equal(res.type, TYPES.BUILD_ONLY)
  t.equal(res.direction, DIRECTIONS.SAME)
  t.equal(res.incompatible, false)
  t.match(res.reasons.join(' '), /build metadata/)
  t.equal(classify('1.2.3+one', '1.2.3+one').type, TYPES.SAME)
  // one side has no build metadata at all
  const noBuild = classify('1.2.3', '1.2.3+one')
  t.equal(noBuild.type, TYPES.BUILD_ONLY)
  t.match(noBuild.reasons.join(' '), /no build metadata/)
  t.end()
})

test('classifies prerelease promotion to a stable release', (t) => {
  const res = classify('1.3.0-rc.1', '1.3.0')
  t.equal(res.type, TYPES.RELEASE)
  t.equal(res.direction, DIRECTIONS.UPGRADE)
  t.equal(res.incompatible, false)
  t.match(res.reasons.join(' '), /prerelease/)
  t.end()
})

test('classifies regressions', (t) => {
  const res = classify('1.2.3', '1.2.2')
  t.equal(res.type, TYPES.REGRESSION)
  t.equal(res.direction, DIRECTIONS.DOWNGRADE)
  t.equal(res.incompatible, false)
  t.match(res.reasons.join(' '), /decreased/)
  t.end()
})

test('classifies 0.x minor bumps as minor with potential incompatibility', (t) => {
  const res = classify('0.2.1', '0.3.0')
  t.equal(res.type, TYPES.MINOR)
  t.equal(res.incompatible, true)
  t.equal(res.direction, DIRECTIONS.UPGRADE)
  t.match(res.reasons.join(' '), /incompatible/)
  t.end()
})

test('does not flag 0.x patch bumps as incompatible', (t) => {
  const res = classify('0.2.1', '0.2.2')
  t.equal(res.type, TYPES.PATCH)
  t.equal(res.incompatible, false)
  t.end()
})

test('classifies identical versions', (t) => {
  [
    ['1.2.3', '1.2.3'],
    ['1.2.3+one', '1.2.3+one'],
    ['1.3.0-rc.1', '1.3.0-rc.1'],
    ['0.2.1', '0.2.1'],
  ].forEach(([from, to]) => {
    const res = classify(from, to)
    t.equal(res.type, TYPES.SAME, `${from} -> ${to} is same`)
    t.equal(res.direction, DIRECTIONS.SAME)
    t.equal(res.incompatible, false)
  })
  t.end()
})

test('classifies prerelease identifier ordering', (t) => {
  [
    ['1.3.0-alpha.1', '1.3.0-alpha.2'],
    ['1.3.0-alpha.1', '1.3.0-beta.1'],
    ['1.3.0-beta.1', '1.3.0-rc.1'],
    ['1.3.0-rc.1', '1.3.0-rc.2'],
  ].forEach(([from, to]) => {
    const res = classify(from, to)
    t.equal(res.type, TYPES.PRERELEASE, `${from} -> ${to} is prerelease`)
    t.equal(res.direction, DIRECTIONS.UPGRADE)
  })
  // prerelease downgrade
  const down = classify('1.3.0-rc.2', '1.3.0-rc.1')
  t.equal(down.type, TYPES.REGRESSION)
  t.equal(down.direction, DIRECTIONS.DOWNGRADE)
  t.end()
})

test('classifies stable to prerelease as prerelease', (t) => {
  const res = classify('1.2.3', '1.3.0-rc.1')
  t.equal(res.type, TYPES.PRERELEASE)
  t.equal(res.direction, DIRECTIONS.UPGRADE)
  t.match(res.reasons.join(' '), /upcoming release bumps the minor/)
  t.end()
})

test('classifies patch/minor/major upgrades', (t) => {
  t.equal(classify('1.2.3', '1.2.4').type, TYPES.PATCH)
  t.equal(classify('1.2.3', '1.3.0').type, TYPES.MINOR)
  t.equal(classify('1.2.3', '2.0.0').type, TYPES.MAJOR)
  t.equal(classify('1.2.3', '2.0.0').incompatible, false)
  t.end()
})

test('accepts loose input', (t) => {
  const res = classify('=1.2.3', '1.2.4', true)
  t.equal(res.type, TYPES.PATCH)
  t.equal(res.from, '1.2.3')
  t.equal(res.to, '1.2.4')
  t.equal(res.fromRaw, '=1.2.3')
  const res2 = classify('1.2.3', '01.02.04', { loose: true })
  t.equal(res2.type, TYPES.PATCH)
  t.end()
})

test('rejects invalid versions before classifying', (t) => {
  t.throws(() => classify('bad', '1.2.3'), { message: 'Invalid Version: bad' })
  t.throws(() => classify('1.2.3', 'bad'), { message: 'Invalid Version: bad' })
  t.throws(() => classify('1.2.3', '1.2.3.4'), { message: 'Invalid Version: 1.2.3.4' })
  t.throws(() => classify('', '1.2.3'), { message: 'Invalid Version: ' })
  t.end()
})

test('retains reasons for every classification', (t) => {
  [
    ['1.2.3+one', '1.2.3+two'],
    ['1.3.0-rc.1', '1.3.0'],
    ['1.2.3', '1.2.2'],
    ['0.2.1', '0.3.0'],
    ['1.2.3', '1.2.3'],
    ['1.2.3', '1.3.0-rc.1'],
    ['1.3.0-rc.2', '1.3.0-rc.1'],
  ].forEach(([from, to]) => {
    const res = classify(from, to)
    t.ok(Array.isArray(res.reasons) && res.reasons.length > 0,
      `${from} -> ${to} has reasons`)
    t.equal(typeof res.type, 'string')
    t.equal(typeof res.direction, 'string')
    t.equal(typeof res.incompatible, 'boolean')
    t.equal(typeof res.from, 'string')
    t.equal(typeof res.to, 'string')
  })
  t.end()
})

test('exposes TYPES and DIRECTIONS constants', (t) => {
  t.equal(TYPES.BUILD_ONLY, 'build-only')
  t.equal(TYPES.RELEASE, 'release')
  t.equal(TYPES.REGRESSION, 'regression')
  t.equal(DIRECTIONS.UPGRADE, 'upgrade')
  t.equal(DIRECTIONS.DOWNGRADE, 'downgrade')
  t.equal(DIRECTIONS.SAME, 'same')
  t.end()
})

test('covers prerelease promotion with a moved release line', (t) => {
  // 1.0.0-1 -> 1.1.1: promoted to a stable release on a different line
  const res = classify('1.0.0-1', '1.1.1')
  t.equal(res.type, TYPES.RELEASE)
  t.match(res.reasons.join(' '), /release line moved/)
  t.end()
})

test('covers prerelease bumps that also move the underlying version', (t) => {
  const res = classify('1.2.3-rc.1', '1.3.0-rc.1')
  t.equal(res.type, TYPES.PRERELEASE)
  t.match(res.reasons.join(' '), /underlying minor version also changed/)
  t.end()
})

test('covers downgrades involving prereleases', (t) => {
  // prerelease -> stable that is still lower precedence
  let res = classify('1.3.0-rc.1', '1.2.3')
  t.equal(res.type, TYPES.REGRESSION)
  t.equal(res.direction, DIRECTIONS.DOWNGRADE)
  t.match(res.reasons.join(' '), /lower precedence/)
  // stable -> prerelease
  res = classify('1.3.0', '1.3.0-rc.1')
  t.equal(res.type, TYPES.REGRESSION)
  t.match(res.reasons.join(' '), /prerelease, which has lower precedence/)
  t.end()
})
