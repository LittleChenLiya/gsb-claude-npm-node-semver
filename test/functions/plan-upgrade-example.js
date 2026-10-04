'use strict'

// Local Node command demo:
//   node examples/plan-upgrade.js
//
// Plans the shortest upgrade chain over a fixed graph of published
// versions and explicit allowed edges, then prints the explanation.

const planUpgrade = require('../../functions/plan-upgrade')

const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0']
const edges = [
  ['1.0.0', '1.1.0'],
  ['1.0.0', '1.2.0'],
  ['1.1.0', '2.0.0'],
  ['1.2.0', '2.0.0'],
]

const scenarios = [
  { label: '两条两步路径，不禁用', start: '1.0.0', target: '2.0.0', disabled: [] },
  { label: '禁用 1.2.x 后', start: '1.0.0', target: '2.0.0', disabled: ['1.2.x'] },
  { label: '目标不存在（^3.0.0）', start: '1.0.0', target: '^3.0.0', disabled: [] },
  { label: '终点被禁用（2.0.0）', start: '1.0.0', target: '2.0.0', disabled: ['2.0.0'] },
]

for (const s of scenarios) {
  console.log('=== ' + s.label + ' ===')
  const res = planUpgrade(versions, edges, s.start, s.target, s.disabled)
  if (res.ok) {
    console.log(res.explanation)
    res.steps.forEach(st => console.log(st.text))
  } else {
    console.log('[' + res.reason + '] ' + res.explanation)
  }
  console.log()
}
