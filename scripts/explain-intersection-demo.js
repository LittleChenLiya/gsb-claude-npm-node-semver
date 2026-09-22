'use strict'

// Demo: node scripts/explain-intersection-demo.js
// Prints the minimal version satisfying each set of ranges, or the
// conflicting comparators (and the ranges they came from) when the
// ranges cannot be satisfied together.

const { explainIntersection } = require('..')

const scenarios = [
  ['>=1.2.0 <2', '>=1.5.0'],
  ['<1.0.0', '>=1.0.0'],
  ['^1.0.0', '>=1.1.0-beta <1.1.0'],
  ['<1.0.0 || >=2.0.0', '1.5.x || 2.3.x'],
]

for (const ranges of scenarios) {
  console.log('ranges: ' + ranges.join('  &&  '))
  const res = explainIntersection(ranges)
  if (res.intersects) {
    console.log('  usable version: ' + res.version)
  } else {
    console.log('  no usable version')
    for (const conflict of res.conflicts) {
      console.log('  conflict (' + conflict.reason + '):')
      for (const { index, comparator } of conflict.comparators) {
        console.log('    range[' + index + '] ' + comparator)
      }
    }
  }
  console.log()
}

const pre = ['^1.0.0', '>=1.1.0-beta <1.1.0']
const res = explainIntersection(pre, { includePrerelease: true })
console.log('ranges: ' + pre.join('  &&  ') + '  (includePrerelease)')
console.log('  usable version: ' + res.version)
