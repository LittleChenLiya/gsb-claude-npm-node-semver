'use strict'

// Resolve the tags of an offline publish manifest (eg `latest`,
// `stable`, or custom tags) to concrete, locked versions.
//
// A manifest is a plain object whose keys are tag names and whose
// values are either the name of another tag or a full valid version.
// The caller provides an allowed range; every tag chain must resolve
// to a version satisfying that range.  The whole batch is validated
// before any locked result is returned: a single missing tag, tag
// cycle, or out-of-range version fails the entire batch and nothing
// is returned.  The manifest object is never mutated (in particular,
// tags are never replaced by cached resolved versions); resolution
// state is kept in local maps only.

const SemVer = require('../classes/semver')
const Range = require('../classes/range')
const compare = require('./compare')

class TagResolutionError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'TagResolutionError'
    this.code = code
    Object.assign(this, details)
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

const parseTerminal = (value, options) => {
  try {
    return new SemVer(value, options)
  } catch {
    // not a full valid version, so it must be a reference to another tag
    return null
  }
}

const resolveOne = (tags, tag, range, rangeRaw, options) => {
  const chain = [tag]
  const seen = new Map([[tag, 0]])
  let current = tag
  for (;;) {
    if (!hasOwn(tags, current)) {
      throw new TagResolutionError('ETAGMISSING',
        `tag "${current}" is not present in the manifest ` +
        `(resolving ${chain.join(' -> ')})`,
        { tag: current, chain: [...chain] })
    }
    const value = tags[current]
    if (typeof value !== 'string' || value.length === 0) {
      throw new TagResolutionError('ETAGINVALID',
        `tag "${current}" must point to another tag or a full valid ` +
        `version, got: ${JSON.stringify(value)}`,
        { tag: current, chain: [...chain], value })
    }
    const parsed = parseTerminal(value, options)
    if (parsed !== null) {
      chain.push(value)
      if (!range.test(parsed)) {
        throw new TagResolutionError('ETAGRANGE',
          `tag "${tag}" resolves to ${parsed.version}, which is not ` +
          `satisfied by the allowed range "${rangeRaw}" ` +
          `(via ${chain.join(' -> ')})`,
          {
            tag,
            chain: [...chain],
            raw: value,
            version: parsed.version,
            range: rangeRaw,
          })
      }
      return Object.freeze({
        tag,
        chain: Object.freeze([...chain]),
        raw: value,
        version: parsed.version,
      })
    }
    if (seen.has(value)) {
      const cycleStart = seen.get(value)
      const cycle = [...chain.slice(cycleStart), value]
      throw new TagResolutionError('ETAGCYCLE',
        `tag cycle detected: ${cycle.join(' -> ')} (cycle starts at ` +
        `"${value}", position ${cycleStart} of the chain)`,
        { tag, chain: [...chain], cycle, cycleStart })
    }
    seen.set(value, chain.length)
    chain.push(value)
    current = value
  }
}

// Resolve a batch of requested tags against a manifest.  Returns an
// array of locked results, one per request and in request order, each
// `{ tag, chain, raw, version }`, where `chain` is the traversed tag
// chain ending in the raw version string, `raw` is the version exactly
// as written in the manifest, and `version` is the canonical version.
// Throws a TagResolutionError (code ETAGMISSING, ETAGCYCLE, ETAGRANGE,
// or ETAGINVALID) if any request fails; no partial results are
// returned.
const resolveTags = (tags, requests, range, options) => {
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new TypeError('tags manifest must be an object mapping tag ' +
      'names to other tags or full valid versions')
  }
  const list = Array.isArray(requests) ? requests : [requests]
  const allowed = new Range(range, options)
  const memo = new Map()
  return list.map((tag) => {
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new TypeError('requested tags must be non-empty strings, ' +
        `got: ${JSON.stringify(tag)}`)
    }
    if (!memo.has(tag)) {
      memo.set(tag, resolveOne(tags, tag, allowed, range, options))
    }
    return memo.get(tag)
  })
}

// Pick the locked result with the highest precedence.  Precedence
// follows the SemVer specification: build metadata is ignored, so two
// versions differing only in build metadata have equal precedence and
// the earliest one wins.
const highest = (results) => {
  let best = null
  for (const result of results) {
    if (best === null || compare(result.version, best.version) > 0) {
      best = result
    }
  }
  return best
}

resolveTags.highest = highest
resolveTags.TagResolutionError = TagResolutionError

module.exports = resolveTags
