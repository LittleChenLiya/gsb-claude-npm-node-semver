'use strict'

const parse = require('./parse.js')

// Result `type` values returned by `classify`.
//   'build-only' : equal SemVer precedence, only build metadata differs
//   'none'       : the versions are identical (including build metadata)
//   'prerelease' : advance within (or into) the prerelease line of the
//                  same major.minor.patch version
//   'release'    : a prerelease is finalized as the matching stable release
//   'patch'      : stable patch-level upgrade (may be flagged prerelease)
//   'minor'      : stable minor-level upgrade (may be flagged prerelease)
//   'major'      : stable major-level upgrade (may be flagged prerelease)
//   'downgrade'  : the target has lower SemVer precedence
const BUILD_ONLY = 'build-only'
const NONE = 'none'
const PRERELEASE = 'prerelease'
const RELEASE = 'release'
const DOWNGRADE = 'downgrade'

// Describe which main component (major.minor.patch) differs first, using the
// same comparison/normalization SemVer relies on everywhere else.
const mainLevel = (v1, v2) => {
  if (v1.major !== v2.major) {
    return 'major'
  }
  if (v1.minor !== v2.minor) {
    return 'minor'
  }
  if (v1.patch !== v2.patch) {
    return 'patch'
  }
  return null
}

const classify = (version1, version2, optionsOrLoose) => {
  // Invalid versions are rejected up front by the SemVer constructor.
  // `parse(..., true)` rethrows the parser's TypeError instead of returning
  // null, so callers cannot accidentally classify garbage.
  const from = parse(version1, optionsOrLoose, true)
  const to = parse(version2, optionsOrLoose, true)

  const comparison = from.compare(to)
  const fromBuild = from.build.join('.')
  const toBuild = to.build.join('.')
  const buildChanged = fromBuild !== toBuild
  const fromHasPre = from.prerelease.length > 0
  const toHasPre = to.prerelease.length > 0

  const result = {
    // normalized versions (build metadata intentionally excluded, it has
    // no effect on SemVer precedence)
    from: from.version,
    to: to.version,
    type: null,
    // 'major' | 'minor' | 'patch' | 'prerelease' | null
    level: null,
    // -1, 0 or 1, exactly like `compare(from, to)`: -1 means `to` sorts
    // higher and is therefore an upgrade
    comparison,
    upgrade: comparison < 0,
    downgrade: comparison > 0,
    buildChanged,
    // target is a prerelease (of the same main version or a higher one)
    prerelease: toHasPre,
    // a prerelease is being promoted to its stable release
    release: false,
    // 0.x upgrades may contain breaking changes per semver, even when they
    // sort as minor/patch. This flags that risk without changing ordering.
    potentiallyBreaking: false,
    // human-readable evidence explaining every decision above
    reasons: [],
  }

  if (comparison === 0) {
    result.upgrade = false
    result.downgrade = false
    result.prerelease = false
    if (!buildChanged) {
      result.type = NONE
      result.reasons.push(
        `versions normalize to the same value "${from.version}" ` +
        'with identical build metadata'
      )
      return result
    }
    result.type = BUILD_ONLY
    result.reasons.push(
      `versions normalize to the same value "${from.version}", so precedence ` +
      'is equal'
    )
    result.reasons.push(
      `only build metadata differs ("${fromBuild}" -> "${toBuild}"), which ` +
      'does not affect SemVer precedence and is not an upgrade'
    )
    return result
  }

  if (comparison < 0) {
    // Upgrade: `to` sorts above `from`.
    const level = mainLevel(from, to)
    result.reasons.push(
      `"${to.version}" has higher SemVer precedence than "${from.version}"`
    )

    result.release = fromHasPre && !toHasPre

    if (result.release) {
      // A prerelease becoming a stable version is a formal release, not a
      // regular patch/minor/major bump.
      result.type = RELEASE
      result.level = level
      result.prerelease = false
      result.reasons.push(
        `prerelease "${from.version}" is finalized as the stable release ` +
        `"${to.version}"`
      )
      if (level) {
        result.reasons.push(`the release also changes the ${level} component`)
      }
    } else if (toHasPre && level === null) {
      // Moving between prerelease identifiers of the same main version.
      result.type = PRERELEASE
      result.level = PRERELEASE
      result.reasons.push(
        `main version ${to.major}.${to.minor}.${to.patch} is unchanged; the ` +
        'prerelease identifiers advance in SemVer precedence order'
      )
    } else {
      // Stable bump, or a jump into the prerelease line of a higher main
      // version (e.g. 1.2.3 -> 2.0.0-rc.1).
      result.type = level
      result.level = level
      result.reasons.push(
        `${level[0].toUpperCase()}${level.slice(1)} component increases ` +
        `(${from.major}.${from.minor}.${from.patch} -> ` +
        `${to.major}.${to.minor}.${to.patch})`
      )
      if (toHasPre) {
        result.reasons.push(
          `the target is a prerelease of the upcoming ${level} release, so ` +
          'the change is not the stable release yet'
        )
      }
    }

    // Per https://semver.org, anything in the 0.x line may break. Keep
    // SemVer ordering untouched (0.2.1 -> 0.3.0 still classifies as
    // 'minor') and put the compatibility risk in its own field. Leaving the
    // 0.x line (e.g. 0.9.9 -> 1.0.0) is a normal major, so no flag.
    if (from.major === 0 && to.major === 0) {
      result.potentiallyBreaking = true
      result.reasons.push(
        `this ${result.type} stays within the 0.x range, where semver does ` +
        'not guarantee API stability, so it may contain breaking changes'
      )
    }

    if (buildChanged) {
      result.reasons.push(
        'build metadata also differs, but is ignored for precedence'
      )
    }

    return result
  }

  // Downgrade: `to` sorts below `from`.
  result.type = DOWNGRADE
  result.level = mainLevel(from, to) || PRERELEASE
  result.reasons.push(
    `"${to.version}" has lower SemVer precedence than "${from.version}"`
  )
  if (result.level === PRERELEASE) {
    result.reasons.push(
      `main version ${to.major}.${to.minor}.${to.patch} is unchanged; the ` +
      'prerelease identifiers move to lower precedence'
    )
  } else {
    result.reasons.push(
      `downgrade crosses the ${result.level} component ` +
      `(${from.version} -> ${to.version})`
    )
  }
  if (buildChanged) {
    result.reasons.push(
      'build metadata also differs, but is ignored for precedence'
    )
  }

  return result
}

module.exports = classify
