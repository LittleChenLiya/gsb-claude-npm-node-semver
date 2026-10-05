/* IMPORTANT
 * This snapshot file is auto-generated, but designed for humans.
 * It should be checked into source control and tracked carefully.
 * Re-generate by setting TAP_SNAPSHOT=1 and running tests.
 * Make sure to inspect the output below.  Do not ignore changes!
 */
'use strict'
exports[`test/functions/release-index.js TAP build metadata variants share one precedence group > index entries keep distinct build identities 1`] = `
Array [
  Object {
    "precedence": "0.9.0",
    "sources": Array [
      2,
    ],
    "version": "0.9.0",
  },
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      0,
    ],
    "version": "1.0.0+a",
  },
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      1,
    ],
    "version": "1.0.0+b",
  },
  Object {
    "precedence": "2.0.0",
    "sources": Array [
      3,
    ],
    "version": "2.0.0",
  },
]
`

exports[`test/functions/release-index.js TAP duplicate full versions merge and record every source position > merged duplicate sources 1`] = `
Array [
  Object {
    "precedence": "0.1.0",
    "sources": Array [
      1,
    ],
    "version": "0.1.0",
  },
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      0,
      2,
    ],
    "version": "1.0.0+a",
  },
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      3,
    ],
    "version": "1.0.0+b",
  },
]
`

exports[`test/functions/release-index.js TAP range query returns all real build identities > range query result 1`] = `
Array [
  "1.0.0+b",
  "1.0.0+a",
  "1.2.0",
]
`

exports[`test/functions/release-index.js TAP same precedence group keeps input order when input is reordered > reordered input stays stable within group 1`] = `
Array [
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      0,
    ],
    "version": "1.0.0+b",
  },
  Object {
    "precedence": "1.0.0",
    "sources": Array [
      1,
    ],
    "version": "1.0.0+a",
  },
]
`
