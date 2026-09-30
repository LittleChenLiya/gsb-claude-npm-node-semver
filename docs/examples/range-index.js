'use strict'

// RangeIndex demo: prints matching ids for version queries and shows
// that a rejected update leaves the index unchanged.
// Runs in well under 90 seconds: node docs/examples/range-index.js

const { RangeIndex } = require('../..')

const index = new RangeIndex([
  { id: 'web', range: '^1.2.3' },
  { id: 'api', range: '>=2.0.0 <3.0.0' },
  { id: 'legacy', range: '0.9.x || 1.0.x' },
  // this range keeps its own includePrerelease option
  { id: 'beta',
    range: '>=3.0.0-alpha.1 <3.0.0',
    options: { includePrerelease: true } },
])

for (const version of ['1.4.0', '2.5.0', '0.9.3', '3.0.0-beta.2', '9.9.9']) {
  console.log(`query ${version} -> matched ids:`, index.query(version))
}

// a batch containing a bad range is rejected as a whole
try {
  index.update({
    delete: ['api', 'web'],
    set: [
      { id: 'web', range: '^1.4.0' }, // would replace web
      { id: 'oops', range: 'not a valid range' },
    ],
  })
  console.log('update unexpectedly succeeded')
  process.exitCode = 1
} catch (er) {
  console.log(`rejected update: ${er.message}`)
}

console.log('ids after rejected update:', index.ids())
console.log('query 2.5.0 after rejected update -> matched ids:',
  index.query('2.5.0'))

// a valid batch applies atomically, including delete+replace of one id
index.update({
  delete: ['api', 'web'],
  set: [{ id: 'web', range: '^1.4.0' }],
})
console.log('ids after valid update:', index.ids())
console.log('query 1.4.2 after valid update -> matched ids:',
  index.query('1.4.2'))
