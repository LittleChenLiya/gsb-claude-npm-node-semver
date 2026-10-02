'use strict'

// Short demo: lock the tag chains of an offline publish manifest to
// concrete versions.  Run with: node docs/resolve-tags-demo.js

const { resolveTags } = require('..')

const manifest = {
  latest: 'stable',
  stable: 'release',
  release: 'v1.2.3',
  beta: '1.3.0-beta.1',
}

const allowedRange = '^1.0.0 || >=1.3.0-beta.1 <2.0.0'

for (const locked of resolveTags(manifest, ['latest', 'beta'], allowedRange)) {
  console.log(`${locked.tag}: ${locked.chain.join(' -> ')}`)
  console.log(`  raw:     ${locked.raw}`)
  console.log(`  version: ${locked.version}`)
}

// The whole batch is validated before anything is returned: one
// missing tag fails every request.
try {
  resolveTags(manifest, ['stable', 'missing'], allowedRange)
} catch (er) {
  console.log(`batch failed as one unit: [${er.code}] ${er.message}`)
}

// Cycles report where the loop closes.
try {
  resolveTags({ stable: 'release', release: 'stable' }, ['stable'], '^1.0.0')
} catch (er) {
  console.log(`cycle: [${er.code}] ${er.message}`)
}
