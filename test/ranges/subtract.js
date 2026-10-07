'use strict'

const t = require('tap')
const subtractRange = require('../../ranges/subtract.js')
const Range = require('../../classes/range')
const SemVer = require('../../classes/semver')
const satisfies = require('../../functions/satisfies.js')
const compare = require('../../functions/compare.js')
const { MAX_SAFE_INTEGER } = require('../../internal/constants')

const MAX = String(MAX_SAFE_INTEGER)

t.test('acceptance: >=1.0.0 <3.0.0 minus >=1.5.0 <2.0.0', t => {
  const res = subtractRange('>=1.0.0 <3.0.0', '>=1.5.0 <2.0.0')
  t.equal(res.expressible, true)
  t.equal(res.fragments.length, 2, 'two fragments survive')
  t.same(res.fragments.map(f => f.minVersion), ['1.0.0', '2.0.0'])
  // every fragment re-parses
  for (const f of res.fragments) {
    t.ok(new Range(f.range), `fragment re-parses: ${f.range}`)
  }
  t.ok(new Range(res.range), 'combined range re-parses')
  // boundary versions, checked one by one
  const expectations = [
    ['0.9.9', false],
    ['1.0.0', true],
    ['1.4.9', true],
    ['1.5.0', false],
    ['1.9.9', false],
    ['2.0.0', true],
    ['2.5.0', true],
    ['2.9.9', true],
    ['3.0.0', false],
  ]
  for (const [v, wanted] of expectations) {
    t.equal(satisfies(v, res.range), wanted, `${v} ${wanted ? 'hits' : 'misses'}`)
    // and the naive definition agrees
    t.equal(satisfies(v, res.range),
      satisfies(v, '>=1.0.0 <3.0.0') && !satisfies(v, '>=1.5.0 <2.0.0'),
      `${v} matches the naive difference`)
  }
  t.end()
})

t.test('boundary checks, one by one', t => {
  const cases = [
    // [allowed, blocked, [[version, expected], ...]]
    ['>=1.0.0 <2.0.0', '>1.0.0 <2.0.0', [
      ['1.0.0', true], // only the closed lower edge survives
      ['1.0.1', false],
      ['1.5.0', false],
    ]],
    ['>1.0.0 <2.0.0', '>=1.0.0 <2.0.0', [
      ['1.0.0', false],
      ['1.0.1', false],
      ['2.0.0', false],
    ]],
    ['<=2.0.0', '<2.0.0', [
      ['2.0.0', true], // only the closed upper edge survives
      ['1.9.9', false],
      ['2.0.1', false],
    ]],
    ['<2.0.0', '<=2.0.0', [
      ['1.9.9', false],
      ['2.0.0', false],
    ]],
    ['>=1.0.0 <=1.0.0', '<1.0.0', [
      ['1.0.0', true],
      ['0.9.9', false],
    ]],
    ['>=1.0.0 <=1.0.0', '<=1.0.0', [
      ['1.0.0', false],
    ]],
    ['>1.2.3', '>=1.2.4', [
      ['1.2.3', false],
      ['1.2.4', false],
      ['1.2.5', false], // everything > 1.2.3 is >= 1.2.4 for releases
    ]],
    ['>1.2.3', '>=1.2.4 <1.2.5', [
      ['1.2.4', false],
      ['1.2.5', true],
      ['1.2.6', true],
    ]],
  ]
  for (const [allowed, blocked, checks] of cases) {
    const res = subtractRange(allowed, blocked)
    t.equal(res.expressible, true, `${allowed} - ${blocked} expressible`)
    for (const [v, wanted] of checks) {
      t.equal(satisfies(v, res.range), wanted,
        `${allowed} - ${blocked}: ${v} ${wanted ? 'hits' : 'misses'}`)
    }
  }
  t.end()
})

t.test('empty sets and full coverage', t => {
  // blocked matches nothing: difference is the allowed range
  let res = subtractRange('>=1.0.0 <2.0.0', '<0.0.0-0')
  t.equal(res.expressible, true)
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.5.0', res.range))
  t.notOk(satisfies('2.0.0', res.range))

  // allowed matches nothing: difference is empty
  res = subtractRange('<0.0.0-0', '*')
  t.equal(res.expressible, true)
  t.same(res.fragments, [])
  t.equal(res.range, '<0.0.0-0', 'empty difference is the null range')
  t.ok(new Range(res.range), 'null range re-parses')
  t.notOk(satisfies('1.0.0', res.range))

  // full coverage by an identical range
  res = subtractRange('>=1.0.0 <2.0.0', '>=1.0.0 <2.0.0')
  t.same(res.fragments, [])
  t.equal(res.range, '<0.0.0-0')

  // full coverage by a superset
  res = subtractRange('>=1.0.0 <2.0.0', '*')
  t.same(res.fragments, [])

  // full coverage by a union
  res = subtractRange('>=1.0.0 <2.0.0', '<1.5.0 || >=1.5.0')
  t.same(res.fragments, [])

  // single version minus itself
  res = subtractRange('1.2.3', '1.2.3')
  t.same(res.fragments, [])

  // allowed empty, blocked empty
  res = subtractRange('<0.0.0-0', '<0.0.0-0')
  t.same(res.fragments, [])
  t.end()
})

t.test('abutting intervals', t => {
  // blocked ends exactly where allowed begins
  let res = subtractRange('>=1.0.0 <2.0.0', '<1.0.0')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.0.0', res.range), 'touching lower edge kept')
  t.ok(satisfies('1.9.9', res.range))

  // blocked begins exactly where allowed ends
  res = subtractRange('>=1.0.0 <2.0.0', '>=2.0.0')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.9.9', res.range))
  t.notOk(satisfies('2.0.0', res.range))

  // blocked abuts on both sides, allowed untouched
  res = subtractRange('>=1.0.0 <2.0.0', '<1.0.0 || >=2.0.0')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.0.0', res.range))
  t.ok(satisfies('1.9.9', res.range))

  // disjoint open and closed rays: nothing is subtracted
  res = subtractRange('>1.0.0', '<=1.0.0')
  t.equal(res.fragments.length, 1)
  t.equal(res.fragments[0].minVersion, '1.0.1')
  t.ok(satisfies('2.0.0', res.range))

  // no release version fits between two exclusive neighboring bounds
  res = subtractRange('>1.0.0 <1.0.1', '<0.0.0-0')
  t.same(res.fragments, [])

  // closed edge against open edge: a single version survives
  res = subtractRange('>=1.0.0', '<1.0.0 || >1.0.0')
  t.equal(res.fragments.length, 1)
  t.equal(res.fragments[0].minVersion, '1.0.0')
  t.ok(satisfies('1.0.0', res.range))
  t.notOk(satisfies('1.0.1', res.range))
  t.notOk(satisfies('0.9.9', res.range))

  // splitting into three abutting pieces
  res = subtractRange('>=1.0.0 <4.0.0', '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('2.0.0', res.range))
  t.ok(satisfies('2.9.9', res.range))
  t.notOk(satisfies('1.9.9', res.range))
  t.notOk(satisfies('3.0.0', res.range))
  t.end()
})

t.test('prerelease ranges', t => {
  // prerelease comparator in allowed opens its tuple for prereleases
  let res = subtractRange('>=1.0.0-alpha <2.0.0', '>=1.5.0 <2.0.0')
  t.equal(res.expressible, true)
  t.ok(satisfies('1.0.0-alpha', res.range), 'lower prerelease edge hits')
  t.ok(satisfies('1.0.0-beta.2', res.range), 'same-tuple prerelease hits')
  t.notOk(satisfies('1.2.3-alpha', res.range),
    'unmentioned tuple stays gated out')
  t.ok(satisfies('1.2.3', res.range))
  t.notOk(satisfies('1.5.0', res.range))
  t.notOk(satisfies('2.0.0-alpha', res.range))

  // blocked with a prerelease comparator only blocks that tuple
  res = subtractRange('>=1.0.0-alpha <2.0.0', '>=1.0.0-beta <1.0.0')
  t.ok(satisfies('1.0.0-alpha', res.range))
  t.notOk(satisfies('1.0.0-beta', res.range))
  t.notOk(satisfies('1.0.0-rc.1', res.range))
  t.ok(satisfies('1.0.0', res.range))
  t.ok(satisfies('1.5.0', res.range))

  // blocked prerelease range does not touch releases at all
  res = subtractRange('>=1.0.0 <2.0.0', '>=1.0.0-beta <1.0.0')
  t.ok(satisfies('1.5.0', res.range))
  t.notOk(satisfies('1.0.0-beta', res.range),
    'allowed never matched that prerelease anyway')

  // a prerelease-only island
  res = subtractRange('>=1.2.3-alpha <1.2.3', '>=1.2.3-beta <1.2.3')
  t.equal(res.fragments.length, 1)
  t.equal(res.fragments[0].minVersion, '1.2.3-alpha')
  t.ok(satisfies('1.2.3-alpha.1', res.range))
  t.notOk(satisfies('1.2.3-beta', res.range))
  t.notOk(satisfies('1.2.3', res.range))

  // includePrerelease: no gating, plain interval difference
  res = subtractRange('>=1.0.0-alpha <2.0.0', '>=1.5.0 <2.0.0',
    { includePrerelease: true })
  t.equal(res.expressible, true)
  const opts = { includePrerelease: true }
  t.ok(satisfies('1.2.3-alpha', res.range, opts))
  t.ok(satisfies('1.5.0-alpha', res.range, opts),
    '1.5.0-alpha is below the blocked 1.5.0 edge')
  t.notOk(satisfies('1.6.0-alpha', res.range, opts))
  t.notOk(satisfies('1.5.0', res.range, opts))
  t.ok(satisfies('1.0.0-alpha', res.range, opts))
  t.end()
})

t.test('build metadata', t => {
  // build metadata in ranges is stripped by the parser; the difference
  // never mentions it, and versions with build metadata compare equal
  const res = subtractRange('>=1.0.0+build.1 <2.0.0', '<1.5.0+other')
  t.equal(res.expressible, true)
  t.notMatch(res.range, '+', 'no build metadata in output')
  t.ok(satisfies('1.7.0+anything', res.range))
  t.notOk(satisfies('1.4.0+build', res.range))
  t.equal(res.fragments[0].minVersion, '1.5.0')

  const res2 = subtractRange('>=1.0.0 <2.0.0', '1.5.0+build.5')
  t.notOk(satisfies('1.5.0+other.build', res2.range),
    'blocked version with build metadata still blocked')
  t.ok(satisfies('1.5.1+xyz', res2.range))
  t.end()
})

t.test('safe integer boundaries', t => {
  // >1.0.MAX: the next release must carry into the minor component,
  // never producing the invalid version 1.0.(MAX+1)
  let res = subtractRange(`>1.0.${MAX} <2.0.0`, '<0.0.0-0')
  t.equal(res.expressible, true)
  t.equal(res.fragments[0].minVersion, '1.1.0')
  t.ok(new SemVer(res.fragments[0].minVersion), 'witness is a valid version')

  // carry all the way into major
  res = subtractRange(`>1.${MAX}.${MAX}`, '<0.0.0-0')
  t.equal(res.fragments[0].minVersion, '2.0.0')

  // no version exists above MAX.MAX.MAX: the fragment is exactly empty
  res = subtractRange(`>${MAX}.${MAX}.${MAX}`, '<0.0.0-0')
  t.equal(res.expressible, true)
  t.same(res.fragments, [])
  t.equal(res.range, '<0.0.0-0')

  // ...but the inclusive bound at MAX.MAX.MAX is satisfiable
  res = subtractRange(`>=${MAX}.${MAX}.${MAX}`, '<0.0.0-0')
  t.equal(res.fragments.length, 1)
  t.equal(res.fragments[0].minVersion, `${MAX}.${MAX}.${MAX}`)

  // includePrerelease next-version also carries safely
  res = subtractRange(`>1.0.${MAX}`, '<0.0.0-0', { includePrerelease: true })
  t.equal(res.fragments[0].minVersion, '1.1.0-0')
  t.end()
})

t.test('does not mutate Range inputs', t => {
  const allowed = new Range('>=1.0.0-alpha <3.0.0 || 4.0.0')
  const blocked = new Range('>=1.5.0 <2.0.0')
  const snapshot = r => JSON.stringify({
    range: r.range,
    raw: r.raw,
    set: r.set.map(s => s.map(c => [c.operator, c.value])),
  })
  const beforeA = snapshot(allowed)
  const beforeB = snapshot(blocked)
  const res = subtractRange(allowed, blocked)
  t.equal(res.expressible, true)
  t.equal(snapshot(allowed), beforeA, 'allowed range unchanged')
  t.equal(snapshot(blocked), beforeB, 'blocked range unchanged')
  t.end()
})

t.test('output is stable', t => {
  const a = '>=1.0.0-alpha <3.0.0 || 4.0.0'
  const b = '>=1.5.0 <2.0.0 || 3.5.0'
  const first = subtractRange(a, b)
  const second = subtractRange(a, b)
  t.same(second, first, 'same inputs give identical output')
  t.end()
})

t.test('inexpressible results are reported, never widened', t => {
  // a witness prerelease that would exceed the maximum version length
  const longPre = 'a'.repeat(249) // '1.2.3-' + 249 = 255 chars, valid
  const res = subtractRange(`>1.2.3-${longPre}`, '<0.0.0-0')
  t.equal(res.expressible, false)
  t.equal(res.range, null)
  t.equal(res.fragments, null)
  t.match(res.reason, /cannot construct version/)

  // a difference needing an absurd number of fragments
  const intervals = []
  for (let i = 0; i < 1100; i++) {
    intervals.push(`>=${i + 1}.0.0 <${i + 1}.0.1`)
  }
  const res2 = subtractRange('*', intervals.join(' || '))
  t.equal(res2.expressible, false)
  t.match(res2.reason, /fragments/)
  t.end()
})

t.test('throws on invalid ranges like the rest of the library', t => {
  t.throws(() => subtractRange('not a range', '*'), TypeError)
  t.throws(() => subtractRange('*', 'not a range'), TypeError)
  t.end()
})

t.test('set equivalence over a generated small domain', t => {
  // a small but dense domain of versions, including prereleases and
  // build metadata
  const domain = []
  const tuples = [
    [0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 2, 3], [1, 5, 0], [2, 0, 0],
  ]
  const pres = [[], [0], [0, 1], ['alpha'], ['alpha', 1], ['beta']]
  for (const [M, m, p] of tuples) {
    for (const pr of pres) {
      let v = `${M}.${m}.${p}`
      if (pr.length) {
        v += `-${pr.join('.')}`
      }
      domain.push(v)
    }
  }
  domain.push('1.2.3+build.5', '1.5.0-alpha+meta', '2.0.0+100')

  // comparator pool over the same domain
  const poolVersions = [
    '0.0.0', '0.1.0', '1.0.0', '1.0.0-alpha', '1.2.3',
    '1.2.3-0', '1.5.0', '1.5.0-beta', '2.0.0',
  ]
  const pool = []
  for (const op of ['', '<', '<=', '>', '>=']) {
    for (const v of poolVersions) {
      pool.push(op + v)
    }
  }

  // deterministic PRNG so the test is stable
  let seed = 20261007
  const rand = n => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const randomRange = () => {
    const sets = []
    const setCount = 1 + rand(2)
    for (let i = 0; i < setCount; i++) {
      const comps = []
      const compCount = 1 + rand(2)
      for (let k = 0; k < compCount; k++) {
        comps.push(pool[rand(pool.length)])
      }
      sets.push(comps.join(' '))
    }
    return sets.join(' || ')
  }

  const optionSets = [undefined, { includePrerelease: true }]
  t.plan(optionSets.length)
  for (const options of optionSets) {
    t.test(`options ${JSON.stringify(options)}`, t => {
      t.plan(200)
      for (let i = 0; i < 200; i++) {
        const allowed = randomRange()
        const blocked = randomRange()
        const res = subtractRange(allowed, blocked, options)
        t.test(`${allowed} - ${blocked}`, t => {
          t.equal(res.expressible, true, 'expressible')
          // the combined range re-parses
          t.ok(new Range(res.range, options), 'range re-parses')
          for (const f of res.fragments) {
            t.ok(new Range(f.range, options), `fragment re-parses: ${f.range}`)
            // the witness satisfies its own fragment and the difference
            t.ok(satisfies(f.minVersion, f.range, options),
              `witness ${f.minVersion} satisfies its fragment`)
            t.ok(satisfies(f.minVersion, allowed, options) &&
              !satisfies(f.minVersion, blocked, options),
            `witness ${f.minVersion} is in the difference`)
          }
          // exact set equivalence on every domain version
          for (const v of domain) {
            const expected = satisfies(v, allowed, options) &&
              !satisfies(v, blocked, options)
            const actual = satisfies(v, res.range, options)
            if (expected !== actual) {
              t.fail(`${v}: expected ${expected}, got ${actual}`)
              return t.end()
            }
            // nothing below a fragment witness may satisfy that fragment
            for (const f of res.fragments) {
              if (compare(v, f.minVersion, options) < 0 &&
                satisfies(v, f.range, options)) {
                t.fail(`${v} < minVersion ${f.minVersion} satisfies ${f.range}`)
                return t.end()
              }
            }
          }
          t.pass('equivalent on the whole domain')
          t.end()
        })
      }
    })
  }
})

t.test('internal edge cases', t => {
  // prerelease tuple class whose lower bound lands above the tuple
  let res = subtractRange('>=1.2.3-alpha >=2.0.0', '<0.0.0-0')
  t.equal(res.expressible, true)
  t.same(res.fragments.map(f => f.range), ['>=2.0.0'],
    'only the release fragment survives')

  // same situation on the blocked side: the part matches nothing
  res = subtractRange('>=1.0.0 <3.0.0', '>=1.2.3-alpha >=2.0.0')
  t.same(res.fragments.map(f => f.range), ['>=1.0.0 <2.0.0'])

  // prerelease tuple class capped by its own release version
  res = subtractRange('>=1.2.3-alpha >=1.2.3', '<0.0.0-0')
  t.same(res.fragments.map(f => f.range), ['>=1.2.3'])
  res = subtractRange('>=1.0.0 <3.0.0', '>=1.2.3-alpha >=1.2.3')
  t.same(res.fragments.map(f => f.range), ['>=1.0.0 <1.2.3'])

  // a blocked conjunction of two different versions matches nothing
  res = subtractRange('>=1.0.0 <2.0.0', '1.2.3 1.2.4')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.5.0', res.range))

  // a blocked version pinned outside its own bound matches nothing
  res = subtractRange('>=1.0.0 <3.0.0', '1.2.3 >=2.0.0')
  t.equal(res.fragments.length, 1)
  t.ok(satisfies('1.2.3', res.range))

  // an eq comparator outside the prerelease tuple of its own class
  res = subtractRange('>=1.2.3-alpha 4.5.6', '<0.0.0-0')
  t.same(res.fragments.map(f => f.range), ['4.5.6'])
  t.ok(satisfies('4.5.6', res.range))
  t.notOk(satisfies('1.2.3-alpha', res.range))
  // same situation on the blocked side
  res = subtractRange('>=1.0.0 <3.0.0', '>=1.2.3-alpha 4.5.6')
  t.same(res.fragments.map(f => f.range), ['>=1.0.0 <3.0.0'])

  // duplicate simple ranges produce a single fragment
  res = subtractRange('1.2.3 || 1.2.3', '<0.0.0-0')
  t.same(res.fragments.map(f => f.range), ['1.2.3'])

  // equal-fragment dedupe keeps stable ordering across equal minVersions
  res = subtractRange('1.2.3 || >=1.2.3 <2.0.0', '<0.0.0-0')
  t.same(res.fragments.map(f => f.minVersion), ['1.2.3', '1.2.3'])
  t.equal(res.fragments.length, 2)

  // a lone prerelease version is its own fragment
  res = subtractRange('1.2.3-alpha', '<0.0.0-0')
  t.same(res.fragments.map(f => f.range), ['1.2.3-alpha'])
  t.equal(res.fragments[0].minVersion, '1.2.3-alpha')

  // strict lower bound inside a prerelease tuple
  res = subtractRange('>1.2.3-alpha <1.2.3', '<0.0.0-0')
  t.equal(res.fragments[0].minVersion, '1.2.3-alpha.0')
  t.ok(satisfies('1.2.3-alpha.1', res.range))
  t.notOk(satisfies('1.2.3-alpha', res.range))

  // guards coincide with the tightest bounds
  res = subtractRange('>=1.2.3-0 <1.2.3', '<0.0.0-0')
  t.equal(res.fragments.length, 1)
  t.equal(res.fragments[0].minVersion, '1.2.3-0')

  // the universal range, with and without includePrerelease
  res = subtractRange('*', '<0.0.0-0')
  t.same(res.fragments, [{ range: '>=0.0.0', minVersion: '0.0.0' }])
  res = subtractRange('*', '<0.0.0-0', { includePrerelease: true })
  t.same(res.fragments, [{ range: '*', minVersion: '0.0.0-0' }])

  // no version above MAX.MAX.MAX, even with includePrerelease
  res = subtractRange(`>${MAX}.${MAX}.${MAX}`, '<0.0.0-0',
    { includePrerelease: true })
  t.same(res.fragments, [])
  t.end()
})

t.test('fragment ordering tie-breaks', t => {
  // same minVersion, fragment strings compared both ways
  const res1 = subtractRange('1.2.3 || >=1.2.3 <2.0.0', '<0.0.0-0')
  const res2 = subtractRange('>=1.2.3 <2.0.0 || 1.2.3', '<0.0.0-0')
  t.same(res1, res2, 'output order does not depend on input order')
  t.same(res1.fragments.map(f => f.range), ['1.2.3', '>=1.2.3 <2.0.0'])
  t.end()
})
