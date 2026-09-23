'use strict'

// 90-second tour of the offline solver: a successful selection, an
// unsatisfiable input with its conflict source, and a budget exit.
// Run with: node scripts/solver-example.js

const solve = require('../lib/solver.js')

const print = (title, result) => {
  console.log('=== ' + title + ' ===')
  console.log(JSON.stringify(result, null, 2))
  console.log()
}

// 1. success: app@2.0.0 wants lib ^2, app@1.0.0 wants lib ^1, and the
// second root only allows lib ^1, so the solver backtracks to app 1.0.0
// and picks the highest usable lib 1.x
print('solved selection', solve({
  packages: {
    app: {
      versions: [
        { version: '2.0.0', dependencies: { lib: '^2.0.0' } },
        { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      ],
    },
    lib: {
      versions: [{ version: '2.0.0' }, { version: '1.5.0' }, { version: '1.0.0' }],
    },
  },
  roots: { app: '>=1.0.0', lib: '^1.0.0' },
}))

// 2. unsat: app only exists as 2.0.0, which needs lib ^2 while the root
// pins lib to ^1; the conflict report names the constraints and the
// source path that activated them
print('unsat with conflict source', solve({
  packages: {
    app: {
      versions: [{ version: '2.0.0', dependencies: { lib: '^2.0.0' } }],
    },
    lib: {
      versions: [{ version: '2.0.0' }, { version: '1.5.0' }],
    },
  },
  roots: { app: '>=1.0.0', lib: '^1.0.0' },
}))

// 3. budget exit: the same search as (1) but with a candidate-attempt
// budget one short of what the search needs
print('budget exhausted', solve({
  packages: {
    app: {
      versions: [
        { version: '2.0.0', dependencies: { lib: '^2.0.0' } },
        { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      ],
    },
    lib: {
      versions: [{ version: '2.0.0' }, { version: '1.5.0' }, { version: '1.0.0' }],
    },
  },
  roots: { app: '>=1.0.0', lib: '^1.0.0' },
  options: { budget: 6 },
}))
