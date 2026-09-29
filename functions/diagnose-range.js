'use strict'

const Range = require('../classes/range')

// Parse a version range for editor diagnostics.  Unlike validRange() this
// never collapses an invalid range to a single error.  Instead it returns
// the raw range, each `||` branch and every comparator inside a branch,
// all with [start, end] offsets into the original input string.
//
// The returned object has:
//   raw       - the original range string
//   valid     - true when there are no errors
//   branches  - one entry per `||` branch, each with `comparators`
//   errors    - every invalid token, with a message and a [start, end] range
//   test(v)   - true/false like satisfies() for a fully valid range,
//               null when an invalid branch makes the result undecidable
const diagnoseRange = (range, options) => Range.diagnose(range, options)

module.exports = diagnoseRange
