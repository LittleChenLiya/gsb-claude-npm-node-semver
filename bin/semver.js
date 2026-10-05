#!/usr/bin/env node
// Standalone semver comparison program.
// Exits successfully and prints matching version(s) if
// any supplied version is valid and passes all tests.

'use strict'

const argv = process.argv.slice(2)

let versions = []

const range = []

let inc = null

const version = require('../package.json').version

let loose = false

let includePrerelease = false

let coerce = false

let rtl = false

let identifier

let identifierBase

const semver = require('../')
const parseOptions = require('../internal/parse-options')

let reverse = false

let index = false

let options = {}

const main = () => {
  if (!argv.length) {
    return help()
  }
  while (argv.length) {
    let a = argv.shift()
    const indexOfEqualSign = a.indexOf('=')
    if (indexOfEqualSign !== -1) {
      const value = a.slice(indexOfEqualSign + 1)
      a = a.slice(0, indexOfEqualSign)
      argv.unshift(value)
    }

    switch (a) {
      case '-rv': case '-rev': case '--rev': case '--reverse':
        reverse = true
        break
      case '-l': case '--loose':
        loose = true
        break
      case '-p': case '--include-prerelease':
        includePrerelease = true
        break
      case '-v': case '--version':
        versions.push(argv.shift())
        break
      case '-i': case '--inc': case '--increment':
        if (semver.RELEASE_TYPES.includes(argv[0]) || (argv[0] === 'release')) {
          inc = { value: argv.shift(), maybeErrantValue: null, option: a }
        } else {
          inc = { value: 'patch', maybeErrantValue: argv[0], option: a }
        }
        break
      case '--preid':
        identifier = argv.shift()
        break
      case '-r': case '--range':
        range.push(argv.shift())
        break
      case '-n':
        identifierBase = argv.shift()
        if (identifierBase === 'false') {
          identifierBase = false
        }
        break
      case '-c': case '--coerce':
        coerce = true
        break
      case '--index':
        index = true
        break
      case '--rtl':
        rtl = true
        break
      case '--ltr':
        rtl = false
        break
      case '-h': case '--help': case '-?':
        return help()
      default:
        versions.push(a)
        break
    }
  }

  options = parseOptions({ loose, includePrerelease, rtl })

  if (index) {
    if (inc) {
      return failIndex()
    }

    const input = versions.map((v) => {
      return coerce ? (semver.coerce(v, options) || { version: v }).version : v
    })

    // Batch validation: manifest() throws if any single version is invalid,
    // so an invalid item produces no index at all.
    let manifest
    try {
      manifest = semver.manifest(input, options)
    } catch (er) {
      console.error(er.message)
      return fail()
    }

    // Range queries return every real version identity; build metadata is
    // never used for range comparison.
    const entries = range.length ? manifest.range(range, options) : [...manifest]
    if (!entries.length) {
      return fail()
    }

    entries
      .map((entry) => `${entry.full} (${entry.sources.join(', ')})`)
      .forEach(line => console.log(line))
    return
  }

  if (
    inc &&
    versions.includes(inc.maybeErrantValue) &&
    !semver.valid(inc.maybeErrantValue, options)
  ) {
    console.warn(`Invalid value for ${inc.option}; defaulting to 'patch'. This may become a failure in future major versions.`)
  }

  versions = versions.map((v) => {
    return coerce ? (semver.coerce(v, options) || { version: v }).version : v
  }).filter((v) => {
    return semver.valid(v, options)
  })
  if (!versions.length) {
    return fail()
  }
  if (inc && (versions.length !== 1 || range.length)) {
    return failInc()
  }

  for (let i = 0, l = range.length; i < l; i++) {
    versions = versions.filter((v) => {
      return semver.satisfies(v, range[i], options)
    })
    if (!versions.length) {
      return fail()
    }
  }
  versions
    .sort((a, b) => semver[reverse ? 'rcompare' : 'compare'](a, b, options))
    .map(v => semver.clean(v, options))
    .map(v => inc ? semver.inc(v, inc.value, options, identifier, identifierBase) : v)
    .forEach(v => console.log(v))
}

const failInc = () => {
  console.error('--inc can only be used on a single version with no range')
  fail()
}

const failIndex = () => {
  console.error('--index can not be combined with --inc')
  fail()
}

const fail = () => process.exit(1)

const help = () => console.log(
`SemVer ${version}

A JavaScript implementation of the https://semver.org/ specification
Copyright Isaac Z. Schlueter

Usage: semver [options] <version> [<version> [...]]
Prints valid versions sorted by SemVer precedence

Options:
-r --range <range>
        Print versions that match the specified range.

-i --increment [<level>]
        Increment a version by the specified level.  Level can
        be one of: major, minor, patch, premajor, preminor,
        prepatch, prerelease, or release.  Default level is 'patch'.
        Only one version may be specified.

--preid <identifier>
        Identifier to be used to prefix premajor, preminor,
        prepatch or prerelease version increments.

-l --loose
        Interpret versions and ranges loosely

-p --include-prerelease
        Always include prerelease versions in range matching

-c --coerce
        Coerce a string into SemVer if possible
        (does not imply --loose)

--rtl
        Coerce version strings right to left

--ltr
        Coerce version strings left to right (default)

--index
        Build a release manifest index instead of printing sorted versions.
        Versions are sorted by SemVer precedence; versions that differ only
        in build metadata (e.g. 1.0.0+a and 1.0.0+b) are distinct entries
        that share a precedence group, and entries in the same group keep
        their original input order.  Duplicate full versions are merged and
        every source position is printed in parentheses.  If any supplied
        version is invalid, the whole batch is rejected and nothing is
        printed.  When combined with -r, range queries return every real
        version identity; build metadata is never used for comparison.

        Example:
          semver --index 1.0.0+a 2.0.0 1.0.0+b 1.0.0+a
          1.0.0+a (0, 3)
          1.0.0+b (1)
          2.0.0 (2)

          semver --index -r 1.x 1.0.0+a 1.0.0+b 2.0.0
          1.0.0+a (0)
          1.0.0+b (1)

-n <base>
        Base number to be used for the prerelease identifier.
        Can be either 0 or 1, or false to omit the number altogether.
        Defaults to 0.

Program exits successfully if any valid version satisfies
all supplied ranges, and prints all satisfying versions.

If no satisfying versions are found, then exits failure.

Versions are printed in ascending order, so supplying
multiple versions to the utility will just sort them.`)

main()
