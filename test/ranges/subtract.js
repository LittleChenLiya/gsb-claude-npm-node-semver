'use strict'

const t = require('tap')
const subtractRange = require('../../ranges/subtract.js')
const Range = require('../../classes/range')
const Comparator = require('../../classes/comparator')
const SemVer = require('../../classes/semver')
const satisfies = require('../../functions/satisfies.js')
const { MAX_SAFE_INTEGER } = require('../../internal/constants')

const MAX = MAX_SAFE_INTEGER

// the difference is empty: every version satisfying `allowed` also
// satisfies `blocked`
const NULL_SET = '<0.0.0-0'

// check that the result of subtractRange(allowed, blocked) is exactly the
// set difference on the given domain of versions
const checkEquivalent = (t, allowed, blocked, domain, options) => {
  const res = subtractRange(allowed, blocked, options)
  t.equal(res.diagnostics.length, 0, `no diagnostics for ${allowed} - ${blocked}`)
  const resultRange = res.range || NULL_SET
  // result must be re-parseable
  new Range(resultRange, options)
  for (const v of domain) {
    const expected = satisfies(v, allowed, options) && !satisfies(v, blocked, options)
    const actual = satisfies(v, resultRange, options)
    t.equal(actual, expected,
      `${v} :: (${allowed}) - (${blocked}) = ${resultRange}`)
  }
  return res
}

// a small generated domain of versions, including prereleases and build
// metadata, used for set-equivalence checks
const buildDomain = () => {
  const domain = []
  const tuples = []
  for (const major of [0, 1, 2, 3]) {
    for (const minor of [0, 1, 5]) {
      for (const patch of [0, 1, 9]) {
        tuples.push(`${major}.${minor}.${patch}`)
      }
    }
  }
  // extra tuples around the interesting boundaries
  tuples.push('1.4.999', '1.5.0', '1.9.9', '2.0.0', '2.999.999', '1.2.3', '1.2.4')
  for (const tuple of new Set(tuples)) {
    domain.push(tuple)
    domain.push(`${tuple}+build.1`)
    for (const pre of ['0', 'alpha', 'alpha.0', 'alpha.1', 'beta', 'rc.1']) {
      domain.push(`${tuple}-${pre}`)
      domain.push(`${tuple}-${pre}+b.2`)
    }
  }
  return [...new Set(domain)]
}

const domain = buildDomain()

t.test('acceptance: >=1.0.0 <3.0.0 minus >=1.5.0 <2.0.0', t => {
  const res = subtractRange('>=1.0.0 <3.0.0', '>=1.5.0 <2.0.0')
  t.same(res.diagnostics, [], 'no diagnostics')
  t.same(res.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
  ], 'two fragments with witnesses')
  t.equal(res.range, '>=1.0.0 <1.5.0 || >=2.0.0 <3.0.0')

  // boundary versions, checked one by one
  const cases = [
    ['0.999.999', false],
    ['1.0.0', true],
    ['1.0.0-0', false], // prerelease not allowed without includePrerelease
    ['1.4.999', true],
    ['1.5.0', false],
    ['1.5.0-0', false],
    ['1.9.9', false],
    ['2.0.0', true],
    ['2.0.0-0', false],
    ['2.999.999', true],
    ['3.0.0', false],
    ['3.0.0-0', false],
  ]
  for (const [v, expected] of cases) {
    t.equal(satisfies(v, res.range), expected, `${v} satisfies=${expected}`)
  }
  t.end()
})

t.test('empty differences', t => {
  const empties = [
    ['>=1.0.0 <2.0.0', '>=1.0.0 <2.0.0'], // identical
    ['>=1.0.0 <2.0.0', '*'], // fully covered
    ['1.2.3', '1.2.3'], // same pin
    ['1.2.3', '>=1.0.0'], // covered pin
    ['>=1.0.0 <2.0.0', '>=0.0.0 <3.0.0'], // strictly covered
    ['<0.0.0-0', '*'], // null set minus anything
    ['*', '*'],
    ['>=1.5.0 <1.5.0', '>=2.0.0'], // empty allowed range
  ]
  for (const [allowed, blocked] of empties) {
    const res = subtractRange(allowed, blocked)
    t.same(res.fragments, [], `${allowed} - ${blocked} is empty`)
    t.equal(res.range, null)
    t.same(res.diagnostics, [])
  }
  t.end()
})

t.test('full coverage and identity', t => {
  const res = subtractRange('>=1.0.0 <2.0.0', '<0.0.0-0')
  t.same(res.fragments, [{ range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' }])

  const everything = subtractRange('*', '<0.0.0-0')
  t.same(everything.fragments, [{ range: '*', minVersion: '0.0.0' }])

  const noOverlap = subtractRange('>=1.0.0 <2.0.0', '>=2.0.0 <3.0.0')
  t.same(noOverlap.fragments, [{ range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' }])
  t.end()
})

t.test('touching intervals (edge-adjacent)', t => {
  // blocked touches but does not overlap the allowed bounds
  const left = subtractRange('>=1.0.0 <2.0.0', '<1.0.0')
  t.same(left.fragments, [{ range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' }])
  const right = subtractRange('>=1.0.0 <2.0.0', '>=2.0.0')
  t.same(right.fragments, [{ range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' }])

  // blocked shares exactly one boundary version with an inclusive bound
  const shared = subtractRange('>=1.0.0 <=2.0.0', '>=2.0.0 <3.0.0')
  t.same(shared.fragments, [{ range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' }])
  t.notOk(satisfies('2.0.0', shared.range), '2.0.0 removed')
  t.ok(satisfies('1.999.999', shared.range), '1.999.999 kept')

  // exclusive bounds meeting at a point
  const meet = subtractRange('>1.0.0 <2.0.0', '<=1.0.0')
  t.same(meet.fragments, [{ range: '>1.0.0 <2.0.0', minVersion: '1.0.1' }])

  // removing a single pin splits the range; the successor of the pin is
  // the witness of the right fragment
  const pin = subtractRange('>=1.0.0 <2.0.0', '1.5.0')
  t.same(pin.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>1.5.0 <2.0.0', minVersion: '1.5.1' },
  ])
  t.notOk(satisfies('1.5.0', pin.range))
  t.ok(satisfies('1.5.1', pin.range))
  t.ok(satisfies('1.4.9', pin.range))
  t.end()
})

t.test('pins and exact versions', t => {
  const res = subtractRange('1.2.3', '<1.2.3')
  t.same(res.fragments, [{ range: '>=1.2.3 <=1.2.3', minVersion: '1.2.3' }])
  t.ok(satisfies('1.2.3', res.range))
  t.notOk(satisfies('1.2.4', res.range))

  const prePin = subtractRange('1.2.3-alpha', '<1.0.0')
  t.same(prePin.fragments, [
    { range: '>=1.2.3-alpha <=1.2.3-alpha', minVersion: '1.2.3-alpha' },
  ])
  t.ok(satisfies('1.2.3-alpha', prePin.range))
  t.notOk(satisfies('1.2.3-beta', prePin.range))
  t.end()
})

t.test('prerelease handling without includePrerelease', t => {
  // prereleases of a tuple mentioned by the allowed range survive when
  // the blocked range does not mention that tuple
  const res = subtractRange('>=1.5.0-alpha <2.0.0', '>=1.0.0 <1.8.0')
  t.same(res.fragments, [
    { range: '>=1.5.0-alpha <1.5.0', minVersion: '1.5.0-alpha' },
    { range: '>=1.8.0 <2.0.0', minVersion: '1.8.0' },
  ])
  t.ok(satisfies('1.5.0-beta', res.range), '1.5.0-beta kept')
  t.notOk(satisfies('1.6.0', res.range), '1.6.0 blocked')
  t.ok(satisfies('1.8.0', res.range), '1.8.0 kept')

  // blocked range mentions the same tuple: prereleases are subtracted
  const sameTuple = subtractRange('>=1.0.0-alpha <2.0.0', '>=1.0.0-beta <1.5.0')
  t.same(sameTuple.fragments, [
    { range: '>=1.0.0-alpha <1.0.0-beta', minVersion: '1.0.0-alpha' },
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
  ])
  t.ok(satisfies('1.0.0-alpha.1', sameTuple.range))
  t.notOk(satisfies('1.0.0-beta', sameTuple.range))
  t.notOk(satisfies('1.0.0', sameTuple.range))
  t.ok(satisfies('1.5.0', sameTuple.range))

  // blocked bound with a prerelease tuple the allowed range never
  // mentions must not introduce that tuple into the result
  const snap = subtractRange('>=1.0.0 <2.0.0', '>1.5.0-beta <1.8.0')
  t.same(snap.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=1.8.0 <2.0.0', minVersion: '1.8.0' },
  ])
  t.notOk(satisfies('1.5.0-alpha', snap.range),
    '1.5.0 prereleases not introduced')
  t.notOk(satisfies('1.5.0', snap.range), '1.5.0 itself is blocked')
  t.ok(satisfies('1.4.9', snap.range), '1.4.9 kept')
  t.notOk(satisfies('1.6.0', snap.range), '1.6.0 blocked')
  t.end()
})

t.test('prerelease handling with includePrerelease', t => {
  const opts = { includePrerelease: true }
  const res = subtractRange('>=1.0.0-0 <2.0.0', '>=1.5.0-0 <1.5.0', opts)
  t.same(res.fragments, [
    { range: '>=1.0.0-0 <1.5.0-0', minVersion: '1.0.0-0' },
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
  ])
  t.ok(satisfies('1.2.0-alpha', res.range, opts))
  t.notOk(satisfies('1.5.0-0', res.range, opts))
  t.notOk(satisfies('1.5.0-rc.1', res.range, opts))
  t.ok(satisfies('1.5.0', res.range, opts))

  const all = subtractRange('*', '<2.0.0-0', opts)
  t.same(all.fragments, [{ range: '>=2.0.0-0', minVersion: '2.0.0-0' }])
  t.end()
})

t.test('build metadata is ignored like the rest of the library', t => {
  const res = subtractRange('>=1.0.0+meta <3.0.0', '>=1.5.0 <2.0.0+other')
  t.same(res.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
  ])
  t.equal(
    satisfies('1.5.0+build', res.range),
    satisfies('1.5.0', res.range),
    'build metadata does not affect matching')
  t.ok(satisfies('2.0.0+build', res.range))
  t.end()
})

t.test('OR unions in both inputs', t => {
  const res = subtractRange(
    '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0',
    '>=1.5.0 <3.5.0')
  t.same(res.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=3.5.0 <4.0.0', minVersion: '3.5.0' },
  ])
  checkEquivalent(t,
    '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0',
    '>=1.5.0 <3.5.0', domain)

  // multiple blocked branches
  const multi = subtractRange('>=1.0.0 <3.0.0',
    '>=1.2.0 <1.3.0 || >=1.5.0 <1.6.0')
  t.same(multi.fragments, [
    { range: '>=1.0.0 <1.2.0', minVersion: '1.0.0' },
    { range: '>=1.3.0 <1.5.0', minVersion: '1.3.0' },
    { range: '>=1.6.0 <3.0.0', minVersion: '1.6.0' },
  ])
  t.end()
})

t.test('safe integer boundaries are respected', t => {
  // no invalid version may be constructed by adding one at the boundary
  const covered = subtractRange('>=1.0.0', `<=${MAX}.${MAX}.${MAX}`)
  t.same(covered.fragments, [], 'nothing above the max version')
  t.equal(covered.range, null)

  const atMax = subtractRange('>=1.0.0', `<${MAX}.${MAX}.${MAX}`)
  t.same(atMax.fragments, [{
    range: `>=${MAX}.${MAX}.${MAX}`,
    minVersion: `${MAX}.${MAX}.${MAX}`,
  }], 'pin at the maximum version')

  // witness just past a MAX patch carries into the minor component
  const carry = subtractRange('>=1.0.0', `<=${MAX}.0.0`)
  t.same(carry.fragments, [{
    range: `>${MAX}.0.0`,
    minVersion: `${MAX}.0.1`,
  }])

  const carryMinor = subtractRange('>=1.0.0', `<=1.${MAX}.${MAX}`)
  t.same(carryMinor.fragments, [{
    range: `>1.${MAX}.${MAX}`,
    minVersion: '2.0.0',
  }])

  // exclusive bound at the very top of the domain is the empty set
  const top = subtractRange(`>${MAX}.${MAX}.${MAX}`, '<0.0.0-0')
  t.same(top.fragments, [])
  t.end()
})

t.test('does not mutate Range inputs', t => {
  const allowed = new Range('>=1.0.0 <3.0.0')
  const blocked = new Range('>=1.5.0 <2.0.0')
  const allowedSnapshot = allowed.range
  const blockedSnapshot = blocked.range
  const allowedSet = JSON.stringify(allowed.set, (k, v) =>
    typeof v === 'symbol' ? '@@ANY@@' : v)
  const res = subtractRange(allowed, blocked)
  t.equal(allowed.range, allowedSnapshot, 'allowed range unchanged')
  t.equal(blocked.range, blockedSnapshot, 'blocked range unchanged')
  t.equal(JSON.stringify(allowed.set, (k, v) =>
    typeof v === 'symbol' ? '@@ANY@@' : v), allowedSet, 'allowed set unchanged')
  t.same(res.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
  ])

  // a Range built with different options is re-parsed, not mutated
  const preAllowed = new Range('>=1.0.0-0 <2.0.0', { includePrerelease: true })
  const preRes = subtractRange(preAllowed, '>=1.5.0 <2.0.0')
  t.equal(preAllowed.includePrerelease, true, 'input options unchanged')
  t.same(preRes.diagnostics, [])
  t.end()
})

t.test('fragments re-parse and witnesses are minimal on the domain', t => {
  const pairs = [
    ['>=1.0.0 <3.0.0', '>=1.5.0 <2.0.0'],
    ['>=1.0.0 <2.0.0', '1.5.0'],
    ['>=1.5.0-alpha <2.0.0', '>=1.0.0 <1.8.0'],
    ['*', '>=1.0.0 <2.0.0'],
  ]
  for (const [allowed, blocked] of pairs) {
    const res = subtractRange(allowed, blocked)
    for (const f of res.fragments) {
      // re-parseable
      const r = new Range(f.range)
      t.ok(r instanceof Range, `${f.range} re-parses`)
      // witness satisfies the fragment and the difference
      t.ok(satisfies(f.minVersion, f.range), `${f.minVersion} in fragment`)
      t.ok(satisfies(f.minVersion, allowed), `${f.minVersion} in allowed`)
      t.notOk(satisfies(f.minVersion, blocked),
        `${f.minVersion} not in blocked`)
      // witness is minimal: no smaller domain version satisfies the fragment
      for (const v of domain) {
        if (satisfies(v, f.range)) {
          t.notOk(new SemVer(v) < new SemVer(f.minVersion),
            `${v} not smaller than witness ${f.minVersion}`)
        }
      }
    }
  }
  t.end()
})

t.test('set equivalence on the generated small domain', t => {
  const pairs = [
    // acceptance and plain intervals
    ['>=1.0.0 <3.0.0', '>=1.5.0 <2.0.0'],
    ['>=1.0.0 <2.0.0', '>=0.0.0'],
    ['>=1.0.0 <2.0.0', '*'],
    ['*', '>=1.0.0 <2.0.0'],
    ['>=1.0.0 <2.0.0', '<1.0.0'],
    ['>=1.0.0 <2.0.0', '>=2.0.0'],
    ['>1.2.3 <2.0.0', '<1.2.4'],
    ['>=1.0.0 <2.0.0', '1.5.0'],
    ['1.2.3', '>=1.0.0 <1.2.3'],
    ['>=1.0.0 <=2.0.0', '>=2.0.0 <3.0.0'],
    // open bounds meeting prerelease boundaries
    ['>1.2.3 <1.2.4', '<0.0.0-0'],
    ['>1.2.3 <2.0.0', '>=1.2.4-0 <1.5.0'],
    // prereleases
    ['>=1.0.0-alpha <2.0.0', '>=1.0.0-beta <1.5.0'],
    ['>=1.5.0-alpha <2.0.0', '>=1.0.0 <1.8.0'],
    ['>=1.0.0 <2.0.0', '>1.5.0-beta <1.8.0'],
    ['>=1.0.0-0 <2.0.0', '>=1.0.0 <1.5.0'],
    ['>=1.0.0 <=1.5.0-beta', '>1.5.0-alpha <1.5.0'],
    ['>=1.0.0-alpha <1.0.0', '>1.0.0-alpha <1.0.0-alpha.5'],
    ['1.2.3-alpha', '>=1.0.0'],
    // unions on both sides
    ['>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0', '>=1.5.0 <3.5.0'],
    ['>=1.0.0 <3.0.0', '>=1.2.0 <1.3.0 || >=1.5.0 <1.6.0'],
    ['1.2.3 || 1.5.0-alpha || >=2.0.0 <3.0.0', '>=1.2.0 <2.5.0'],
    // desugared range syntax
    ['^1.2.0', '~1.5.0'],
    ['1.2.3 - 2.3.4', '1.5.x'],
    ['1.x', '>1.5.0 <1.8.0'],
  ]
  for (const [allowed, blocked] of pairs) {
    checkEquivalent(t, allowed, blocked, domain)
  }
  // and the same battery with includePrerelease
  for (const [allowed, blocked] of pairs) {
    checkEquivalent(t, allowed, blocked, domain, { includePrerelease: true })
  }
  t.end()
})

t.test('inexpressible inputs produce diagnostics, never widening', t => {
  // a comparator that is not an interval bound cannot be modeled; the
  // library never produces one, but a hand-doctored Range can carry one
  const weird = new Comparator('>=1.0.0')
  weird.operator = '!='
  weird.value = '!=1.0.0'

  const allowed = new Range('>=1.0.0 <2.0.0')
  allowed.set = [[weird]]
  const resA = subtractRange(allowed, '>=1.5.0')
  t.equal(resA.diagnostics.length, 1, 'one diagnostic')
  t.equal(resA.diagnostics[0].code, 'INEXPRESSIBLE')
  t.match(resA.diagnostics[0].message, /not an interval bound/)
  t.same(resA.fragments, [], 'offending part omitted, not widened')

  const blocked = new Range('>=1.5.0')
  blocked.set = [[weird]]
  const resB = subtractRange('>=1.0.0 <2.0.0', blocked)
  t.equal(resB.diagnostics.length, 1, 'one diagnostic')
  t.equal(resB.diagnostics[0].code, 'INEXPRESSIBLE')
  t.same(resB.fragments, [], 'no result rather than a widened one')
  t.equal(resB.range, null)
  t.end()
})

t.test('invalid ranges throw like the rest of the library', t => {
  t.throws(() => subtractRange('not a range', '*'), TypeError)
  t.throws(() => subtractRange('*', 'not a range'), TypeError)
  t.end()
})

t.test('redundant and equal bounds within a branch', t => {
  // two lower bounds at the same version combine inclusivity
  const res = subtractRange('>=1.0.0 >1.0.0 <3.0.0', '>=1.5.0 <2.0.0')
  t.same(res.fragments, [
    { range: '>1.0.0 <1.5.0', minVersion: '1.0.1' },
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
  ])
  // two upper bounds at the same version
  const res2 = subtractRange('>=1.0.0 <2.0.0 <=2.0.0', '>=1.5.0 <1.8.0')
  t.same(res2.fragments, [
    { range: '>=1.0.0 <1.5.0', minVersion: '1.0.0' },
    { range: '>=1.8.0 <2.0.0', minVersion: '1.8.0' },
  ])
  t.end()
})

t.test('prerelease lanes outside the allowed interval are skipped', t => {
  // tuple mentioned, but the interval starts at/above its release
  const above = subtractRange('>=1.5.0-alpha >=1.5.0 <2.0.0', '>=1.8.0 <2.0.0')
  t.same(above.fragments, [
    { range: '>=1.5.0 <1.8.0', minVersion: '1.5.0' },
  ])
  // tuple mentioned, but the interval ends below its lowest prerelease
  const below = subtractRange('<=1.5.0-alpha <1.4.0', '<0.0.0-0')
  t.same(below.fragments, [
    { range: '<1.4.0', minVersion: '0.0.0' },
  ])
  t.end()
})

t.test('fragment ordering and de-duplication are stable', t => {
  // same lower bound, one fragment unbounded above
  const res = subtractRange('>=2.0.0 <4.0.0 || >=2.0.0', '>=3.0.0 <3.5.0')
  t.same(res.fragments, [
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
    { range: '>=3.5.0 <4.0.0', minVersion: '3.5.0' },
    { range: '>=3.5.0', minVersion: '3.5.0' },
  ])
  // same bounds with different inclusivity sort by their string, and
  // identical fragments from different branches are de-duplicated
  const res2 = subtractRange('>1.5.0 <3.0.0 || >=1.5.0 <3.0.0', '>=2.0.0 <2.5.0')
  t.same(res2.fragments, [
    { range: '>1.5.0 <2.0.0', minVersion: '1.5.1' },
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
    { range: '>=2.5.0 <3.0.0', minVersion: '2.5.0' },
  ])
  t.end()
})

t.test('safe integer carry through the minor component', t => {
  const res = subtractRange('>=1.0.0', `<=1.2.${MAX}`)
  t.same(res.fragments, [{
    range: `>1.2.${MAX}`,
    minVersion: '1.3.0',
  }])
  t.end()
})

t.test('redundant bounds in either order collapse correctly', t => {
  const res = subtractRange('>=1.5.0 >=1.0.0 <3.0.0', '>=2.0.0 <2.5.0')
  t.same(res.fragments, [
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
    { range: '>=2.5.0 <3.0.0', minVersion: '2.5.0' },
  ])
  const res2 = subtractRange('>=1.0.0 <=3.0.0 <3.5.0', '>=2.0.0 <2.5.0')
  t.same(res2.fragments, [
    { range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' },
    { range: '>=2.5.0 <=3.0.0', minVersion: '2.5.0' },
  ])
  const res3 = subtractRange('>=1.0.0 <=2.0.0 <2.0.0', '<0.0.0-0')
  t.same(res3.fragments, [
    { range: '>=1.0.0 <2.0.0', minVersion: '1.0.0' },
  ])
  t.end()
})

t.test('exclusive prerelease lane bounds', t => {
  const res = subtractRange('>1.5.0-alpha <2.0.0', '<0.0.0-0')
  t.same(res.fragments, [
    { range: '>1.5.0-alpha <1.5.0', minVersion: '1.5.0-alpha.0' },
    { range: '>1.5.0-alpha <2.0.0', minVersion: '1.5.0-alpha.0' },
  ])
  t.ok(satisfies('1.5.0-alpha.0', res.range))
  t.notOk(satisfies('1.5.0-alpha', res.range))

  const unbounded = subtractRange('>=1.5.0-alpha', '<0.0.0-0')
  t.same(unbounded.fragments, [
    { range: '>=1.5.0-alpha <1.5.0', minVersion: '1.5.0-alpha' },
    { range: '>=1.5.0-alpha', minVersion: '1.5.0-alpha' },
  ])
  t.end()
})

t.test('lanes ignore blocked branches that do not mention the tuple', t => {
  const res = subtractRange('>=1.0.0-alpha <2.0.0', '>=1.5.0 <1.8.0')
  t.same(res.fragments, [
    { range: '>=1.0.0-alpha <1.0.0', minVersion: '1.0.0-alpha' },
    { range: '>=1.0.0-alpha <1.5.0', minVersion: '1.0.0-alpha' },
    { range: '>=1.8.0 <2.0.0', minVersion: '1.8.0' },
  ])
  t.end()
})

t.test('sort handles unbounded fragments in both directions', t => {
  const res = subtractRange('>=2.0.0 || <1.0.0', '<0.0.0-0')
  t.same(res.fragments, [
    { range: '<1.0.0', minVersion: '0.0.0' },
    { range: '>=2.0.0', minVersion: '2.0.0' },
  ])
  const res2 = subtractRange('>=2.0.0 || >=2.0.0 <4.0.0', '>=3.0.0 <3.5.0')
  t.same(res2.fragments, [
    { range: '>=2.0.0 <3.0.0', minVersion: '2.0.0' },
    { range: '>=3.5.0 <4.0.0', minVersion: '3.5.0' },
    { range: '>=3.5.0', minVersion: '3.5.0' },
  ])
  const res3 = subtractRange('>=1.5.0 <3.0.0 || >1.5.0 <3.0.0', '>=2.0.0 <2.5.0')
  t.same(res3.fragments, [
    { range: '>1.5.0 <2.0.0', minVersion: '1.5.1' },
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
    { range: '>=2.5.0 <3.0.0', minVersion: '2.5.0' },
  ])
  t.end()
})

t.test('blocked branch mentioning a tuple outside its interval', t => {
  // the blocked branch names tuple 1.5.0 but its interval ends below it
  const res = subtractRange('>=1.5.0-alpha <2.0.0', '<=1.5.0-alpha <1.4.0')
  t.same(res.fragments, [
    { range: '>=1.5.0-alpha <1.5.0', minVersion: '1.5.0-alpha' },
    { range: '>=1.5.0-alpha <2.0.0', minVersion: '1.5.0-alpha' },
  ])
  t.end()
})

t.test('sort compares fragments that are both unbounded', t => {
  // two fragments with no lower bound
  const res = subtractRange('<1.0.0 || <2.0.0', '>=1.0.0 <1.5.0')
  t.same(res.fragments, [
    { range: '<1.0.0', minVersion: '0.0.0' },
    { range: '>=1.5.0 <2.0.0', minVersion: '1.5.0' },
  ])
  // two fragments with no upper bound and the same lower bound version
  const res2 = subtractRange('>=2.0.0 || >2.0.0', '<0.0.0-0')
  t.same(res2.fragments, [
    { range: '>2.0.0', minVersion: '2.0.1' },
    { range: '>=2.0.0', minVersion: '2.0.0' },
  ])
  t.end()
})
