'use strict'

const { test } = require('tap')
const SemVer = require('../../classes/semver')
const Range = require('../../classes/range')
const explain = require('../../ranges/explain')
const satisfies = require('../../functions/satisfies')

test('explain: numeric passes but prerelease admission is rejected', (t) => {
  const report = explain('1.2.3-beta', '>=1.0.0 <2.0.0')

  t.equal(report.version, '1.2.3-beta', 'version is reported')
  t.equal(report.range, '>=1.0.0 <2.0.0', 'normalized range is reported')
  t.same(report.options, { loose: false, includePrerelease: false },
    'options bound to the report')
  t.equal(report.satisfied, false, 'not satisfied')
  t.equal(report.reason, 'prerelease', 'rejected for prerelease reasons')
  t.equal(report.groups.length, 1, 'one OR branch')

  const group = report.groups[0]
  t.equal(group.index, 0, 'branch identity is the index')
  t.same(group.comparators.map(c => c.value), ['>=1.0.0', '<2.0.0'],
    'normalized comparators of the branch')
  t.equal(group.numeric, true, 'numeric comparison passes')
  t.equal(group.prerelease, false, 'prerelease admission rejected')
  t.equal(group.satisfied, false, 'branch rejects the version')
  t.equal(group.rejectedBy, 'prerelease', 'rejected by the prerelease gate')

  t.end()
})

test('explain: includePrerelease flips the prerelease verdict', (t) => {
  const without = explain('1.2.3-beta', '>=1.0.0 <2.0.0')
  t.equal(without.satisfied, false)
  t.equal(without.groups[0].prerelease, false)

  const withOpt = explain('1.2.3-beta', '>=1.0.0 <2.0.0',
    { includePrerelease: true })
  t.equal(withOpt.options.includePrerelease, true, 'option is bound')
  t.equal(withOpt.satisfied, true, 'version is accepted')
  t.equal(withOpt.reason, null)
  t.equal(withOpt.groups[0].numeric, true)
  t.equal(withOpt.groups[0].prerelease, true, 'prerelease admission passes')
  t.equal(withOpt.groups[0].rejectedBy, null)

  const bound = new Range('>=1.0.0 <2.0.0', { includePrerelease: true })
  t.equal(explain('1.2.3-beta', bound).satisfied, true)
  t.equal(bound.explain('1.2.3-beta').satisfied, true, 'Range method works')

  t.end()
})

test('explain: prerelease is not treated as a low version', (t) => {
  // 1.2.3-beta is genuinely LOWER than 1.2.3, so the numeric comparison
  // itself fails; this is not merely an admission-gate rejection.
  const low = explain('1.2.3-beta', '>=1.2.3')
  t.equal(low.groups[0].numeric, false, 'numeric comparison fails')
  t.equal(low.groups[0].rejectedBy, 'numeric', 'rejected numerically')
  t.equal(low.reason, 'numeric')

  // a prerelease comparator for the same mmp admits the version
  const admitted = explain('1.2.3-beta', '>=1.2.3-beta <2.0.0')
  t.equal(admitted.groups[0].numeric, true)
  t.equal(admitted.groups[0].prerelease, true,
    'comparator prerelease for the same mmp admits the version')
  t.equal(admitted.satisfied, true)

  // but a different patchs prerelease is still rejected even though
  // it is numerically within range
  const other = explain('1.2.4-beta', '>=1.2.3-beta <2.0.0')
  t.equal(other.groups[0].numeric, true, 'numeric comparison passes')
  t.equal(other.groups[0].prerelease, false,
    'prerelease of another patch is not admitted')
  t.equal(other.groups[0].rejectedBy, 'prerelease')

  t.end()
})

test('explain: each OR branch gets its own conclusion', (t) => {
  const range = '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0'

  const v1 = explain('1.5.0', range)
  t.equal(v1.satisfied, true, '1.5.0 is accepted')
  t.equal(v1.groups.length, 2, 'both branches are reported')
  t.equal(v1.groups[0].index, 0)
  t.same(v1.groups[0].comparators.map(c => c.value), ['>=1.0.0', '<2.0.0'])
  t.equal(v1.groups[0].satisfied, true, 'first branch accepts')
  t.equal(v1.groups[0].rejectedBy, null)
  t.equal(v1.groups[1].index, 1)
  t.same(v1.groups[1].comparators.map(c => c.value), ['>=3.0.0', '<4.0.0'])
  t.equal(v1.groups[1].numeric, false, 'second branch fails numerically')
  t.equal(v1.groups[1].satisfied, false)
  t.equal(v1.groups[1].rejectedBy, 'numeric')

  const v3 = explain('3.5.0', range)
  t.equal(v3.satisfied, true, '3.5.0 is accepted')
  t.equal(v3.groups[0].numeric, false, 'first branch fails numerically')
  t.equal(v3.groups[0].satisfied, false)
  t.equal(v3.groups[0].rejectedBy, 'numeric')
  t.equal(v3.groups[1].satisfied, true, 'second branch accepts')
  t.equal(v3.groups[1].rejectedBy, null)

  const v5 = explain('5.0.0', range)
  t.equal(v5.satisfied, false, '5.0.0 is rejected')
  t.equal(v5.reason, 'numeric', 'every branch fails numerically')
  t.equal(v5.groups[0].rejectedBy, 'numeric')
  t.equal(v5.groups[1].rejectedBy, 'numeric')

  // prerelease rejection in one branch only: reason stays prerelease
  const pre = explain('1.2.3-beta', range)
  t.equal(pre.satisfied, false)
  t.equal(pre.groups[0].numeric, true, 'first branch is numerically fine')
  t.equal(pre.groups[0].prerelease, false, 'first branch rejects prerelease')
  t.equal(pre.groups[1].numeric, false, 'second branch fails numerically')
  t.equal(pre.reason, 'prerelease', 'the prerelease gate is what blocks')

  t.end()
})

test('explain: only the normalized Range result is used', (t) => {
  // caret, tilde and x-range sugar must show up as their normalized
  // comparators, never as the raw sugar string
  const caret = explain('1.5.0', '^1.2.3')
  t.same(caret.groups[0].comparators.map(c => c.value),
    ['>=1.2.3', '<2.0.0-0'], 'caret normalized comparators')

  const tilde = explain('1.2.9', '~1.2.3')
  t.same(tilde.groups[0].comparators.map(c => c.value),
    ['>=1.2.3', '<1.3.0-0'], 'tilde normalized comparators')

  const xrange = explain('1.2.9', '1.2.x')
  t.same(xrange.groups[0].comparators.map(c => c.value),
    ['>=1.2.0', '<1.3.0-0'], 'x-range normalized comparators')

  // star range: numeric passes, prerelease gate still applies
  const star = explain('1.2.3-beta', '*')
  t.equal(star.groups[0].comparators.length, 1)
  t.equal(star.groups[0].comparators[0].value, '')
  t.equal(star.groups[0].numeric, true)
  t.equal(star.groups[0].prerelease, false)
  t.equal(star.satisfied, false)

  t.end()
})

test('explain: loose option is bound to the report', (t) => {
  const report = explain('1.2.3', '>=1.0.0 <2.0.0', { loose: true })
  t.equal(report.options.loose, true)
  t.equal(report.satisfied, true)

  const bound = new Range('>=1.0.0 <2.0.0', { loose: true })
  t.equal(explain('1.2.3', bound).options.loose, true)
  t.equal(bound.explain('1.2.3').options.loose, true)

  t.end()
})

test('explain: invalid version reports a clear failure', (t) => {
  const report = explain('not-a-version', '>=1.0.0')
  t.equal(report.version, null)
  t.equal(report.satisfied, false)
  t.equal(report.reason, 'invalid-version')
  t.same(report.groups, [])

  t.end()
})

test('explain: accepts SemVer instances', (t) => {
  const report = explain(new SemVer('1.2.3'), '>=1.0.0 <2.0.0')
  t.equal(report.version, '1.2.3')
  t.equal(report.satisfied, true)

  t.end()
})

test('explain: top-level verdict matches satisfies()', (t) => {
  const versions = ['1.2.3', '1.2.3-beta', '1.2.4-beta', '2.0.0', '3.0.0',
    '0.1.0', '1.0.0-rc.1']
  const ranges = ['>=1.0.0 <2.0.0', '^1.2.3', '~1.2.0', '*',
    '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0', '>=1.2.3-beta <2.0.0']
  const options = [undefined, { includePrerelease: true }, { loose: true }]

  for (const range of ranges) {
    for (const version of versions) {
      for (const opts of options) {
        const report = explain(version, range, opts)
        t.equal(report.satisfied, satisfies(version, range, opts),
          version + ' ' + range + ' ' + JSON.stringify(opts))
      }
    }
  }

  t.end()
})

test('explain: three-version interpretation example', (t) => {
  // The same range, three versions, three distinct conclusions:
  //   1.2.3      -> numeric pass, prerelease pass, accepted
  //   1.2.3-beta -> numeric pass, prerelease REJECTED
  //   3.0.0      -> numeric REJECTED
  const range = '>=1.0.0 <2.0.0'

  const stable = explain('1.2.3', range)
  t.equal(stable.groups[0].numeric, true)
  t.equal(stable.groups[0].prerelease, true)
  t.equal(stable.satisfied, true, '1.2.3 is accepted')

  const pre = explain('1.2.3-beta', range)
  t.equal(pre.groups[0].numeric, true,
    '1.2.3-beta: numeric comparison passes')
  t.equal(pre.groups[0].prerelease, false,
    '1.2.3-beta: prerelease admission rejected')
  t.equal(pre.groups[0].rejectedBy, 'prerelease')
  t.equal(pre.satisfied, false)

  const outside = explain('3.0.0', range)
  t.equal(outside.groups[0].numeric, false,
    '3.0.0: numeric comparison rejected')
  t.equal(outside.groups[0].prerelease, true)
  t.equal(outside.groups[0].rejectedBy, 'numeric')
  t.equal(outside.satisfied, false)

  // with prerelease admission enabled, the beta is accepted while the
  // numeric rejection of 3.0.0 stands
  const betaAllowed = explain('1.2.3-beta', range, { includePrerelease: true })
  t.equal(betaAllowed.satisfied, true, 'beta accepted with includePrerelease')
  const stillOutside = explain('3.0.0', range, { includePrerelease: true })
  t.equal(stillOutside.satisfied, false,
    '3.0.0 still rejected with includePrerelease')

  t.end()
})
