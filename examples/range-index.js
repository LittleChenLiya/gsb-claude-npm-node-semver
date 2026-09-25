'use strict'

// RangeIndex demo: index many id-tagged ranges, query matching ids,
// and show that a bad batch update is rejected atomically.
//
// Run with: node examples/range-index.js
// Finishes in a few seconds, well under 90.

const { RangeIndex, Range } = require('..')

// 1. Build an index over 100k id-tagged ranges. Each entry keeps its
//    own includePrerelease option.
const entries = []
for (let i = 0; i < 100000; i++) {
  entries.push({ id: 'pkg-' + i, range: '>=' + i + '.0.0 <' + (i + 1) + '.0.0' })
}
entries.push({ id: 'nightly', range: '>=50000.0.0-alpha <50001.0.0', options: { includePrerelease: true } })
entries.push({ id: 'anything', range: '*' })
entries.push({ id: 'legacy-or', range: '^40000.0.0 || >=50000.0.0 <50000.1.0' })

console.time('build index (100003 ranges)')
const index = new RangeIndex(entries)
console.timeEnd('build index (100003 ranges)')

// 2. Query a version: only the matching ids come back, without
//    scanning every range.
console.time('query 50000.0.5')
const hits = index.query('50000.0.5')
console.timeEnd('query 50000.0.5')
console.log('hits for 50000.0.5      ->', hits)

console.log('hits for 50000.0.0-rc.1 ->', index.query('50000.0.0-rc.1'))
console.log('hits for 999999.0.0     ->', index.query('999999.0.0'))

// 3. Query results are snapshots: updates never mutate them.
const snapshot = index.query('50000.0.5')
index.update([{ id: 'pkg-50000', delete: true }])
console.log('snapshot after update   ->', snapshot, '(unchanged)')
console.log('fresh query             ->', index.query('50000.0.5'))

// 4. Atomic batch update: one bad range rejects the whole batch.
try {
  index.update([
    { id: 'pkg-50000', range: '>=50000.0.0 <50000.2.0' }, // valid, would re-add
    { id: 'broken', range: 'not a real range >>' }, // invalid
  ])
} catch (err) {
  console.log('update rejected         ->', err.message)
}
console.log('after rejected update   ->', index.query('50000.0.5'), '(still no pkg-50000)')
console.log('index size              ->', index.size)

// 5. A valid batch: delete + re-add the same id atomically.
index.update([
  { id: 'pkg-50000', range: new Range('>=50000.0.0 <50000.2.0') },
])
console.log('after valid update      ->', index.query('50000.0.5'))
