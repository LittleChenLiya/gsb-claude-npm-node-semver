'use strict'

// Diagnostic range parser.
//
// Unlike `new Range(range)`, which throws on the first invalid comparator
// and loses all position information, diagnoseRange() always returns a
// result describing exactly which parts of the original range string could
// not be parsed.  This is intended for editors and other tooling that need
// to point at incomplete or invalid input while a range is being typed.
//
// The range syntax supported is the same strict-mode syntax supported by
// the Range class, and all `start`/`end` offsets are indices into the
// original range string, so `raw.slice(start, end)` is always the exact
// source text of the branch, comparator, or error being described.

const Range = require('../classes/range')
const parseOptions = require('../internal/parse-options')

// an operator with no version attached to it yet, eg `>=`, `~`, `^`
const BARE_OPERATOR = /^(?:<=?|>=?|~>?|\^)$/

const WS = /\s/

const makeError = (message, start, end, raw) => ({ message, start, end, raw })

const isValidCondition = (raw, options) => {
  try {
    new Range(raw, options)
    return true
  } catch (er) {
    return false
  }
}

// split the raw string on `||`, returning trimmed [start, end) spans
// that map back into the original string
const splitBranches = (raw) => {
  const spans = []
  let start = 0
  let sep = raw.indexOf('||')
  while (sep !== -1) {
    spans.push(trimSpan(raw, start, sep))
    start = sep + 2
    sep = raw.indexOf('||', start)
  }
  spans.push(trimSpan(raw, start, raw.length))
  return spans
}

const trimSpan = (raw, start, end) => {
  while (start < end && WS.test(raw[start])) {
    start++
  }
  while (end > start && WS.test(raw[end - 1])) {
    end--
  }
  return { start, end }
}

const parseBranch = (raw, start, end, options) => {
  const branch = {
    raw: raw.slice(start, end),
    start,
    end,
    valid: true,
    comparators: [],
    errors: [],
    range: null,
    test: (version) => branch.range !== null && branch.range.test(version),
  }

  if (start === end) {
    // an empty branch is not an error: just like in the Range class it
    // parses to the null comparator, which matches any version
    branch.range = new Range('', options)
    return branch
  }

  // split into whitespace separated tokens, keeping track of where each
  // token lives in the original range string
  const tokens = []
  const tokenRe = /\S+/g
  const text = branch.raw
  let match = tokenRe.exec(text)
  while (match !== null) {
    tokens.push({
      raw: match[0],
      start: start + match.index,
      end: start + match.index + match[0].length,
    })
    match = tokenRe.exec(text)
  }

  // merge tokens into source-level conditions, so that things like
  // `>= 1.2.3` and `1.2.3 - 2.0.0` are treated as single comparators
  // whose spans cover the whole source text they were written with
  const conditions = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const next = tokens[i + 1]
    if (BARE_OPERATOR.test(token.raw)) {
      if (next && next.raw !== '-') {
        conditions.push({
          type: 'comparator',
          raw: raw.slice(token.start, next.end),
          start: token.start,
          end: next.end,
          plain: false,
        })
        i++
      } else {
        // eg a trailing `>=` with nothing after it
        conditions.push({
          type: 'comparator',
          raw: token.raw,
          start: token.start,
          end: token.end,
          plain: false,
          error: `Incomplete comparator: ${token.raw}`,
        })
      }
    } else if (token.raw === '-') {
      const prev = conditions[conditions.length - 1]
      if (prev && prev.plain && next && next.raw !== '-') {
        // `1.2.3 - 2.0.0` style hyphen range, extend the previous token
        prev.type = 'hyphen-range'
        prev.from = { raw: prev.raw, start: prev.start, end: prev.end }
        prev.separator = { raw: '-', start: token.start, end: token.end }
        prev.to = { raw: next.raw, start: next.start, end: next.end }
        prev.raw = raw.slice(prev.start, next.end)
        prev.end = next.end
        prev.plain = false
        i++
      } else {
        conditions.push({
          type: 'comparator',
          raw: token.raw,
          start: token.start,
          end: token.end,
          plain: false,
          error: 'Incomplete hyphen range: -',
        })
      }
    } else {
      conditions.push({
        type: 'comparator',
        raw: token.raw,
        start: token.start,
        end: token.end,
        plain: true,
      })
    }
  }

  for (const cond of conditions) {
    validateCondition(cond, options, branch.errors)
    branch.comparators.push(cond)
  }

  if (branch.errors.length) {
    branch.valid = false
    return branch
  }

  // the whole branch parsed cleanly, so it can be handed to the regular
  // Range parser for version testing
  branch.range = new Range(text, options)
  return branch
}

const validateCondition = (cond, options, errors) => {
  cond.comparators = []
  if (cond.error) {
    errors.push(makeError(cond.error, cond.start, cond.end, cond.raw))
    return
  }
  try {
    const parsed = new Range(cond.raw, options)
    cond.comparators = parsed.set[0]
    return
  } catch (er) {
    // fall through to figure out exactly where the problem is
  }
  if (cond.type === 'hyphen-range') {
    // figure out which side of the `-` is the broken one
    let localized = false
    for (const side of [cond.from, cond.to]) {
      if (!isValidCondition(side.raw, options)) {
        errors.push(makeError(`Invalid comparator: ${side.raw}`,
          side.start, side.end, side.raw))
        localized = true
      }
    }
    if (!localized) {
      // both sides are fine on their own, so the `-` itself is the problem
      errors.push(makeError('Invalid hyphen range',
        cond.separator.start, cond.separator.end, cond.separator.raw))
    }
    return
  }
  errors.push(makeError(`Invalid comparator: ${cond.raw}`,
    cond.start, cond.end, cond.raw))
}

const diagnoseRange = (range, options) => {
  options = parseOptions(options)

  if (range instanceof Range) {
    range = range.raw
  }
  if (typeof range !== 'string') {
    throw new TypeError(`Invalid range. Expected a string, got: ${typeof range}`)
  }

  const branches = splitBranches(range).map(({ start, end }) =>
    parseBranch(range, start, end, options))

  const errors = []
  for (const branch of branches) {
    errors.push(...branch.errors)
  }

  return {
    raw: range,
    valid: errors.length === 0,
    branches,
    errors,
    // returns true when some branch matches, false when nothing matches,
    // or undefined when unparseable parts of the range make it impossible
    // to tell whether the finished range would have matched or not
    test: (version) => {
      let indeterminate = false
      for (const branch of branches) {
        if (branch.errors.length) {
          indeterminate = true
          continue
        }
        if (branch.range.test(version)) {
          return true
        }
      }
      return indeterminate ? undefined : false
    },
  }
}

module.exports = diagnoseRange
