'use strict'

const { test } = require('tap')
const classify = require('../../functions/classify')
const SemVer = require('../../classes/semver')

const check = (t, v1, v2, wanted, extra = {}) => {
  const found = classify(v1, v2, extra.options)
  const cmd = `classify(${v1}, ${v2}${extra.options ? ', options' : ''})`
  for (const [key, value] of Object.entries(wanted)) {
    t.strictSame(found[key], value, `${cmd} ${key} === ${JSON.stringify(value)}`)
  }
  t.equal(found.buildChanged, wanted.type === 'build-only',
    `${cmd} buildChanged matches build-only type`)
  // the result always carries the evidence used to reach the verdict
  t.ok(Array.isArray(found.reasons) && found.reasons.length > 0,
    `${cmd} keeps its reasons`)
  // normalized versions never carry build metadata
  t.equal(found.from, new SemVer(v1, extra.options).version,
    `${cmd} from is normalized`)
  t.equal(found.to, new SemVer(v2, extra.options).version,
    `${cmd} to is normalized`)
}

test('build metadata only is never an upgrade', (t) => {
  check(t, '1.2.3+one', '1.2.3+two', {
    type: 'build-only',
    level: null,
    comparison: 0,
    upgrade: false,
    downgrade: false,
    prerelease: false,
    release: false,
    potentiallyBreaking: false,
  })

  check(t, '1.2.3-alpha.1+one', '1.2.3-alpha.1+two', {
    type: 'build-only',
    level: null,
    comparison: 0,
    upgrade: false,
    prerelease: false,
    release: false,
  })

  check(t, '1.2.3+one', '1.2.3', {
    type: 'build-only',
    comparison: 0,
    upgrade: false,
  })

  t.end()
})

test('identical versions are "none"', (t) => {
  check(t, '1.0.0', '1.0.0', {
    type: 'none',
    level: null,
    comparison: 0,
    upgrade: false,
    downgrade: false,
    buildChanged: false,
  })

  check(t, '1.0.0+build.42', '1.0.0+build.42', {
    type: 'none',
    buildChanged: false,
  })

  t.end()
})

test('prerelease finalized as its stable release', (t) => {
  check(t, '1.3.0-rc.1', '1.3.0', {
    type: 'release',
    level: null,
    comparison: -1,
    upgrade: true,
    downgrade: false,
    prerelease: false,
    release: true,
    potentiallyBreaking: false,
  })

  check(t, '1.2.3-beta.5', '1.2.3', {
    type: 'release',
    level: null,
    release: true,
  })

  // prerelease released alongside a main bump is still a formal release
  check(t, '1.2.0-rc.1', '1.2.4', {
    type: 'release',
    level: 'patch',
    release: true,
  })

  t.end()
})

test('patch / minor / major stable upgrades', (t) => {
  check(t, '1.2.3', '1.2.4', {
    type: 'patch', level: 'patch', comparison: -1,
    upgrade: true, downgrade: false, prerelease: false, release: false,
    potentiallyBreaking: false,
  })

  check(t, '1.2.3', '1.3.0', {
    type: 'minor', level: 'minor', upgrade: true,
  })

  check(t, '1.2.3', '2.0.0', {
    type: 'major', level: 'major', upgrade: true,
  })

  // jumping into the prerelease line of a higher main version keeps the
  // level but is flagged prerelease (and is not the formal release)
  check(t, '1.2.3', '2.0.0-rc.1', {
    type: 'major', level: 'major', comparison: -1,
    upgrade: true, prerelease: true, release: false,
  })

  check(t, '1.2.3', '1.3.0-beta.2', {
    type: 'minor', level: 'minor',
    upgrade: true, prerelease: true, release: false,
  })

  t.end()
})

test('downgrades point backwards', (t) => {
  check(t, '1.2.3', '1.2.2', {
    type: 'downgrade',
    level: 'patch',
    comparison: 1,
    upgrade: false,
    downgrade: true,
    prerelease: false,
    release: false,
    potentiallyBreaking: false,
  })

  check(t, '2.0.0', '1.9.9', {
    type: 'downgrade', level: 'major', comparison: 1, downgrade: true,
  })

  check(t, '1.3.0', '1.2.9', {
    type: 'downgrade', level: 'minor', downgrade: true,
  })

  // stable -> prerelease of the same main version is a downgrade
  check(t, '1.2.3', '1.2.3-rc.1', {
    type: 'downgrade', level: 'prerelease', comparison: 1, downgrade: true,
  })

  // prerelease line moving to lower precedence is also a downgrade
  check(t, '1.0.0-rc.2', '1.0.0-rc.1', {
    type: 'downgrade', level: 'prerelease', comparison: 1, downgrade: true,
  })

  t.end()
})

test('0.x minor stays minor but is flagged potentially breaking', (t) => {
  check(t, '0.2.1', '0.3.0', {
    type: 'minor',
    level: 'minor',
    comparison: -1,
    upgrade: true,
    downgrade: false,
    prerelease: false,
    release: false,
    potentiallyBreaking: true,
  })

  check(t, '0.2.1', '0.2.2', {
    type: 'patch', level: 'patch', potentiallyBreaking: true,
  })

  check(t, '0.9.9', '1.0.0', {
    type: 'major', level: 'major', potentiallyBreaking: false,
  })

  // 0.x prereleases and their releases keep the flag too
  check(t, '0.2.0-beta.1', '0.2.0-beta.2', {
    type: 'prerelease', level: 'prerelease', potentiallyBreaking: true,
  })

  check(t, '0.2.0-rc.1', '0.2.0', {
    type: 'release', level: null, release: true, potentiallyBreaking: true,
  })

  // downgrades inside 0.x are not called potentially breaking upgrades
  check(t, '0.2.1', '0.2.0', {
    type: 'downgrade', potentiallyBreaking: false,
  })

  t.end()
})

test('prerelease identifiers follow SemVer precedence ordering', (t) => {
  // numeric identifiers sort numerically
  check(t, '1.0.0-alpha.1', '1.0.0-alpha.2', {
    type: 'prerelease', level: 'prerelease', comparison: -1,
    upgrade: true, downgrade: false,
    prerelease: true, release: false,
  })

  // longer prerelease sets win when all preceding identifiers are equal
  check(t, '1.0.0-alpha', '1.0.0-alpha.1', {
    type: 'prerelease', level: 'prerelease', upgrade: true,
  })

  // numeric identifiers have lower precedence than alphanumeric ones
  check(t, '1.0.0-alpha.1', '1.0.0-alpha.beta', {
    type: 'prerelease', level: 'prerelease', upgrade: true,
  })

  // the standard semver.org precedence chain
  check(t, '1.0.0-alpha.beta', '1.0.0-beta', {
    type: 'prerelease', upgrade: true,
  })
  check(t, '1.0.0-beta.2', '1.0.0-beta.11', {
    type: 'prerelease', upgrade: true,
  })
  check(t, '1.0.0-beta.11', '1.0.0-rc.1', {
    type: 'prerelease', upgrade: true,
  })

  // backwards along that chain is a prerelease downgrade
  check(t, '1.0.0-rc.1', '1.0.0-beta.11', {
    type: 'downgrade', level: 'prerelease', comparison: 1,
    downgrade: true, prerelease: true,
  })

  t.end()
})

test('loose input is accepted with the loose option', (t) => {
  check(t, '=1.2.3', '1.2.4', {
    type: 'patch', level: 'patch', upgrade: true,
  }, { options: { loose: true } })

  check(t, '01.2.3', '1.2.4', {
    type: 'patch', level: 'patch', upgrade: true,
  }, { options: { loose: true } })

  // loose=true shorthand, matching the rest of the api
  check(t, '1.2.3pre', '1.2.3', {
    type: 'release', level: null, release: true, upgrade: true,
  }, { options: true })

  // strict parsing still rejects loose-only strings
  t.throws(() => classify('=1.2.3', '1.2.4'), {
    message: 'Invalid Version: =1.2.3',
    name: 'TypeError',
  })
  t.throws(() => classify('1.2.3', '1.2.3alpha'), {
    message: 'Invalid Version: 1.2.3alpha',
    name: 'TypeError',
  })

  t.end()
})

test('invalid versions are rejected', (t) => {
  for (const [v1, v2] of [
    ['bad', '1.2.3'],
    ['1.2.3', 'not-a-version'],
    ['01.2.3', '1.2.3'],
    ['1.2.3.4', '1.2.3'],
  ]) {
    t.throws(() => classify(v1, v2), TypeError, `throws for ${v1} -> ${v2}`)
  }
  t.end()
})

test('accepts SemVer instances and preserves loose behavior', (t) => {
  const from = new SemVer('1.2.3+one', { loose: true })
  const to = new SemVer('1.2.3+two', { loose: true })
  t.equal(classify(from, to, { loose: true }).type, 'build-only')

  const looseFrom = new SemVer('v1.2.3', { loose: true })
  t.equal(classify(looseFrom, '1.3.0', { loose: true }).type, 'minor')

  t.end()
})

test('result keeps the evidence for its verdict', (t) => {
  const build = classify('1.2.3+one', '1.2.3+two')
  t.match(build.reasons.join(' '), /build metadata/)
  t.match(build.reasons.join(' '), /precedence is equal/)

  const release = classify('1.3.0-rc.1', '1.3.0')
  t.match(release.reasons.join(' '), /stable release/)

  const back = classify('1.2.3', '1.2.2')
  t.match(back.reasons.join(' '), /lower SemVer precedence/)

  const zero = classify('0.2.1', '0.3.0')
  t.match(zero.reasons.join(' '), /0\.x/)
  t.match(zero.reasons.join(' '), /breaking/)

  const pre = classify('1.0.0-beta.2', '1.0.0-beta.11')
  t.match(pre.reasons.join(' '), /prerelease identifiers/)

  t.end()
})
