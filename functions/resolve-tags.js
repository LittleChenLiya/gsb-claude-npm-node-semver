'use strict'

const parse = require('./parse')
const satisfies = require('./satisfies')
const Range = require('../classes/range')
const parseOptions = require('../internal/parse-options')

// Resolve a chain of tags in an offline release manifest to a pinned,
// definite version.  A manifest maps tag names to either another tag name
// or a complete valid version string:
//
//   {
//     latest: 'v2.1.0',
//     stable: 'release',
//     release: 'v1.2.3',
//   }
//
// Walking a chain preserves the tags traversed.  The walk fails with a
// distinct error for each kind of problem:
//
//  - MissingTagError: a tag named in the chain is not present in the
//    manifest (or a tag value is neither a valid version nor the name of
//    another tag).
//  - TagCycleError: the chain loops back on itself.  The error carries
//    the traversed chain and the tag at which the cycle closes.
//  - VersionRangeError: the chain ends at a valid version, but that
//    version does not satisfy the range supplied for the request.
//
// The whole batch of requests is validated before any result is returned,
// the manifest is never mutated (resolved versions are not written back as
// a cache), and each result carries both the original version spelling and
// the canonical version.

class ResolveTagsError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ResolveTagsError'
    this.code = 'ERESOLVETAGS'
  }
}

class MissingTagError extends ResolveTagsError {
  constructor (tag, referencedBy) {
    super(`Tag not found in manifest: "${tag}"` +
      (referencedBy ? ` (referenced by tag "${referencedBy}")` : ''))
    this.name = 'MissingTagError'
    this.code = 'EMISSINGTAG'
    this.tag = tag
    this.referencedBy = referencedBy
  }
}

class TagCycleError extends ResolveTagsError {
  constructor (chain, cycleTag) {
    super(`Tag cycle detected: ${chain.concat(cycleTag).join(' -> ')} ` +
      `(cycle closes at tag "${cycleTag}")`)
    this.name = 'TagCycleError'
    this.code = 'ETAGCYCLE'
    this.chain = chain
    this.cycleTag = cycleTag
  }
}

class VersionRangeError extends ResolveTagsError {
  constructor (version, range) {
    super(`Resolved version ${version.version} does not satisfy range ${range}`)
    this.name = 'VersionRangeError'
    this.code = 'ENOTINRANGE'
    this.version = version
    this.range = range
  }
}

const resolveOne = (manifest, request, options) => {
  const chain = []
  let current = request.tag

  for (;;) {
    if (chain.includes(current)) {
      throw new TagCycleError(chain, current)
    }

    if (!Object.prototype.hasOwnProperty.call(manifest, current)) {
      throw new MissingTagError(current, chain.length ? chain[chain.length - 1] : null)
    }

    chain.push(current)

    const value = manifest[current]
    if (typeof value !== 'string') {
      throw new TypeError(
        `Invalid value for tag "${current}": expected a tag name or version string`)
    }

    const version = parse(value, options)
    if (version) {
      if (!satisfies(version, request.range, options)) {
        throw new VersionRangeError(version, request.range)
      }
      return {
        tag: request.tag,
        chain,
        version: {
          raw: value,
          version: version.version,
        },
      }
    }

    // Not a valid version, so the value must be the name of another tag.
    current = value
  }
}

const resolveTags = (manifest, requests, options) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError(
      'manifest must be an object mapping tag names to version strings or other tags')
  }
  if (!Array.isArray(requests)) {
    throw new TypeError('requests must be an array of { tag, range } objects')
  }
  options = parseOptions(options)

  // Validate every request up front, so a bad batch never produces partial
  // results and the manifest is never mutated.
  for (const request of requests) {
    if (!request || typeof request !== 'object' ||
        typeof request.tag !== 'string' || !request.tag ||
        typeof request.range !== 'string') {
      throw new TypeError(
        'each request must be an object with a string "tag" and a string "range"')
    }
    new Range(request.range, options)
  }

  return requests.map(request => resolveOne(manifest, request, options))
}

module.exports = resolveTags
module.exports.resolveTags = resolveTags
module.exports.ResolveTagsError = ResolveTagsError
module.exports.MissingTagError = MissingTagError
module.exports.TagCycleError = TagCycleError
module.exports.VersionRangeError = VersionRangeError
