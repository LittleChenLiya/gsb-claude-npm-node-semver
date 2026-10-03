'use strict'

const parse = require('./parse.js')

// The kinds of change that classify() can report in its `type` field.
const TYPES = Object.freeze({
  SAME: 'same',
  BUILD_ONLY: 'build-only',
  PRERELEASE: 'prerelease',
  RELEASE: 'release',
  PATCH: 'patch',
  MINOR: 'minor',
  MAJOR: 'major',
  REGRESSION: 'regression',
})

const DIRECTIONS = Object.freeze({
  UPGRADE: 'upgrade',
  DOWNGRADE: 'downgrade',
  SAME: 'same',
})

const formatBuild = (build) =>
  build.length ? `+${build.join('.')}` : '(no build metadata)'

// Which main (major.minor.patch) component differs between two versions.
const mainChange = (from, to) => {
  if (from.major !== to.major) {
    return 'major'
  }
  if (from.minor !== to.minor) {
    return 'minor'
  }
  if (from.patch !== to.patch) {
    return 'patch'
  }
  return null
}

// Classify the change from version1 to version2.
//
// Returns a plain object describing:
//   - from/to: the normalized versions (and fromRaw/toRaw as given)
//   - type: one of TYPES (same, build-only, prerelease, release,
//     patch, minor, major, regression)
//   - direction: one of DIRECTIONS (upgrade, downgrade, same)
//   - incompatible: true for 0.x minor bumps, which the semver spec
//     treats as potentially incompatible (0.y.z is initial development)
//   - reasons: the human-readable basis for the judgment above
//
// Build metadata never affects precedence: a change that only touches the
// build is reported as `build-only`, never as an upgrade.  Invalid
// versions throw a TypeError before any classification is attempted.
const classify = (version1, version2, options) => {
  // Reuse the SemVer parser/comparator. Invalid versions are rejected
  // before any classification is done.
  const from = parse(version1, options, true)
  const to = parse(version2, options, true)

  const reasons = []
  const precedence = from.compare(to)
  const buildChanged = from.compareBuild(to) !== 0

  const fromPre = from.prerelease.length > 0
  const toPre = to.prerelease.length > 0

  let type
  let direction
  let incompatible = false

  if (precedence === 0) {
    direction = DIRECTIONS.SAME
    if (buildChanged) {
      type = TYPES.BUILD_ONLY
      reasons.push(
        `versions have equal precedence ${from.version} but differ in ` +
        `build metadata: ${formatBuild(from.build)} vs ${formatBuild(to.build)}`
      )
      reasons.push('build metadata does not affect version precedence')
    } else {
      type = TYPES.SAME
      reasons.push(`versions are identical: ${from.version}`)
    }

    return {
      from: from.version,
      to: to.version,
      fromRaw: from.raw,
      toRaw: to.raw,
      type,
      direction,
      incompatible,
      reasons,
    }
  }

  if (precedence < 0) {
    direction = DIRECTIONS.UPGRADE
  } else {
    direction = DIRECTIONS.DOWNGRADE
  }

  if (direction === DIRECTIONS.UPGRADE) {
    if (fromPre && !toPre) {
      // prerelease -> stable: a formal release promoted from a prerelease
      type = TYPES.RELEASE
      reasons.push(
        `${to.version} is a stable release promoted from prerelease ${from.version}`
      )
      const component = mainChange(from, to)
      if (component) {
        reasons.push(
          `the release line moved from ${from.major}.${from.minor}.${from.patch} ` +
          `to ${to.major}.${to.minor}.${to.patch} (${component} component)`
        )
      }
    } else if (!fromPre && toPre) {
      // stable -> prerelease: cutting a prerelease of an upcoming release
      type = TYPES.PRERELEASE
      reasons.push(
        `${to.version} is a prerelease leading to the next stable release`
      )
      const component = mainChange(from, to)
      reasons.push(`the upcoming release bumps the ${component} component`)
    } else if (fromPre && toPre) {
      // prerelease -> prerelease: prerelease identifiers advanced
      type = TYPES.PRERELEASE
      reasons.push(`prerelease advanced from ${from.version} to ${to.version}`)
      const component = mainChange(from, to)
      if (component) {
        reasons.push(`the underlying ${component} version also changed`)
      }
    } else {
      // stable -> stable: major / minor / patch
      const component = mainChange(from, to)
      type = component
      reasons.push(`${component} version increased`)
    }

    // 0.x compatibility risk: per the semver spec, 0.y.z is initial
    // development and anything may change at any time. A minor bump while
    // both versions are still on 0.x is flagged as potentially
    // incompatible, without changing the (SemVer-based) type above.
    if (from.major === 0 && to.major === 0 && from.minor !== to.minor) {
      incompatible = true
      reasons.push(
        '0.x versions are for initial development; a minor bump may ' +
        'introduce incompatible changes (potential incompatibility)'
      )
    }
  } else {
    // downgrade: regression
    type = TYPES.REGRESSION
    if (fromPre && !toPre) {
      reasons.push(
        `${to.version} is a stable release but has lower precedence than ` +
        `prerelease ${from.version}`
      )
    } else if (!fromPre && toPre) {
      reasons.push(
        `${to.version} is a prerelease, which has lower precedence than ` +
        `stable release ${from.version}`
      )
    } else if (fromPre && toPre) {
      reasons.push(`prerelease regressed from ${from.version} to ${to.version}`)
    } else {
      const component = mainChange(from, to)
      reasons.push(`${component} version decreased`)
    }
  }

  return {
    from: from.version,
    to: to.version,
    fromRaw: from.raw,
    toRaw: to.raw,
    type,
    direction,
    incompatible,
    reasons,
  }
}

module.exports = classify
module.exports.TYPES = TYPES
module.exports.DIRECTIONS = DIRECTIONS
