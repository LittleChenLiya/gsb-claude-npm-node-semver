'use strict'

// Demo: plan the shortest allowed upgrade chain with semver ranges.
// Run from the repo root:
//   node docs/examples/plan-upgrade.js

const { planUpgrade } = require('../..')

const spec = {
  versions: ['1.0.0', '1.1.0', '1.2.0', '2.0.0'],
  edges: [
    ['1.0.0', '1.1.0'],
    ['1.1.0', '2.0.0'],
    ['1.0.0', '1.2.0'],
    ['1.2.0', '2.0.0'],
  ],
  from: '1.0.0',
  to: '2.0.0',
  forbidden: ['1.2.x'],
}

console.log('--- shortest allowed chain, 1.2.x forbidden ---')
const plan = planUpgrade(spec)
console.log(plan.explanation)
console.log(plan.steps)

console.log('\n--- no direct edge, no jump ---')
const cut = planUpgrade({ ...spec, edges: [['1.0.0', '1.1.0']], forbidden: [] })
console.log(cut.ok, cut.reason)
console.log(cut.explanation)

console.log('\n--- forbidden target ---')
const blocked = planUpgrade({ ...spec, forbidden: ['2.0.0'] })
console.log(blocked.ok, blocked.reason)
console.log(blocked.explanation)

console.log('\n--- prerelease targets need includePrerelease ---')
const pre = {
  versions: ['1.0.0', '2.0.0-beta.1'],
  edges: [['1.0.0', '2.0.0-beta.1']],
  from: '1.0.0',
  to: '2.x',
}
console.log(planUpgrade(pre).reason)
console.log(planUpgrade({ ...pre, options: { includePrerelease: true } }).explanation)
