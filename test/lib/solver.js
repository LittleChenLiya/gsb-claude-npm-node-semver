'use strict'

const t = require('tap')
const solve = require('../../lib/solver.js')
const SemVer = require('../../classes/semver.js')
const Range = require('../../classes/range.js')

const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      deepFreeze(o[k])
    }
    Object.freeze(o)
  }
  return o
}

const reverseObj = (o) => {
  const out = {}
  for (const k of Object.keys(o).reverse()) {
    out[k] = o[k]
  }
  return out
}

// rebuild an input with every object key order and every versions
// array order reversed; the solver must not observe the difference
const reorder = (input) => {
  const packages = {}
  for (const name of Object.keys(input.packages).reverse()) {
    const entry = input.packages[name]
    packages[name] = {
      versions: [...entry.versions].reverse().map((v) => ({
        version: v.version,
        ...(v.dependencies ? { dependencies: reverseObj(v.dependencies) } : {}),
      })),
    }
  }
  return {
    ...(input.options ? { options: { ...input.options } } : {}),
    roots: reverseObj(input.roots),
    packages,
  }
}

// the acceptance scenario: app 2.0.0 needs lib ^2, app 1.0.0 needs
// lib ^1, and another root only allows lib ^1, so the solver must
// backtrack from app=2.0.0 to app=1.0.0
const backtrackInput = () => ({
  packages: {
    app: {
      versions: [
        { version: '2.0.0', dependencies: { lib: '^2.0.0' } },
        { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      ],
    },
    lib: {
      versions: [
        { version: '2.0.0' },
        { version: '1.5.0' },
        { version: '1.0.0' },
      ],
    },
  },
  roots: { app: '>=1.0.0', lib: '^1.0.0' },
})

t.test('backtracks to a compatible older version', (t) => {
  const r = solve(backtrackInput())
  t.equal(r.status, 'solved')
  t.same(r.assignment, { app: '1.0.0', lib: '1.5.0' })
  t.end()
})

t.test('key order of the input does not change the result', (t) => {
  const a = solve(backtrackInput())
  const b = solve(reorder(backtrackInput()))
  t.same(b, a)
  t.end()
})

t.test('key order of the input does not change unsat diagnostics', (t) => {
  const input = () => ({
    packages: {
      app: { versions: [{ version: '2.0.0', dependencies: { lib: '^2.0.0' } }] },
      lib: { versions: [{ version: '2.0.0' }, { version: '1.5.0' }] },
    },
    roots: { app: '>=1.0.0', lib: '^1.0.0' },
  })
  const a = solve(input())
  const b = solve(reorder(input()))
  t.equal(a.status, 'unsat')
  t.same(b, a)
  t.equal(a.conflict.package, 'lib')
  t.same(a.conflict.constraints, [
    { range: '^1.0.0', source: '<root>' },
    { range: '^2.0.0', source: 'app@2.0.0' },
  ])
  t.end()
})

t.test('conflict path maps to actual constraints of the input', (t) => {
  const input = {
    packages: {
      app: { versions: [{ version: '2.0.0', dependencies: { lib: '^2.0.0' } }] },
      lib: { versions: [{ version: '2.0.0' }, { version: '1.5.0' }] },
    },
    roots: { app: '>=1.0.0', lib: '^1.0.0' },
  }
  const r = solve(input)
  t.equal(r.status, 'unsat')
  const { path, constraints } = r.conflict
  t.ok(path.length >= 2, 'path goes from a root to the conflicted package')
  for (const step of path) {
    if (step.from === '<root>') {
      t.equal(input.roots[step.package], step.range,
        'root step matches the root constraint')
    } else {
      const at = step.from.indexOf('@')
      const fromName = step.from.slice(0, at)
      const fromVersion = step.from.slice(at + 1)
      const cand = input.packages[fromName].versions
        .find((v) => v.version === fromVersion)
      t.ok(cand, 'path source exists in the catalog: ' + step.from)
      t.equal(cand.dependencies[step.package], step.range,
        'path step matches the dependency range of ' + step.from)
    }
  }
  const last = path[path.length - 1]
  t.equal(last.package, r.conflict.package)
  t.ok(constraints.some((c) => c.range === last.range && c.source === last.from),
    'the final path step is one of the reported conflicting constraints')
  t.end()
})

t.test('satisfiable dependency cycle', (t) => {
  const r = solve({
    packages: {
      a: { versions: [{ version: '1.0.0', dependencies: { b: '^1.0.0' } }] },
      b: { versions: [{ version: '1.0.0', dependencies: { a: '^1.0.0' } }] },
    },
    roots: { a: '^1.0.0' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { a: '1.0.0', b: '1.0.0' })
  t.end()
})

t.test('unsatisfiable dependency cycle reports the cycle constraint', (t) => {
  const r = solve({
    packages: {
      a: { versions: [{ version: '1.0.0', dependencies: { b: '^1.0.0' } }] },
      b: { versions: [{ version: '1.0.0', dependencies: { a: '^2.0.0' } }] },
    },
    roots: { a: '^1.0.0' },
  })
  t.equal(r.status, 'unsat')
  t.equal(r.conflict.package, 'a')
  t.equal(r.conflict.version, '1.0.0')
  t.same(r.conflict.constraints, [
    { range: '^1.0.0', source: '<root>' },
    { range: '^2.0.0', source: 'b@1.0.0' },
  ])
  t.end()
})

t.test('diamond dependency picks one shared version', (t) => {
  const r = solve({
    packages: {
      app: {
        versions: [{ version: '1.0.0', dependencies: { b: '^1.0.0', c: '^1.0.0' } }],
      },
      b: { versions: [{ version: '1.0.0', dependencies: { d: '^1.0.0' } }] },
      c: { versions: [{ version: '1.0.0', dependencies: { d: '^1.0.0' } }] },
      d: { versions: [{ version: '1.4.0' }, { version: '1.0.0' }] },
    },
    roots: { app: '^1.0.0' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { app: '1.0.0', b: '1.0.0', c: '1.0.0', d: '1.4.0' })
  t.end()
})

t.test('prerelease candidates follow the includePrerelease option', (t) => {
  const input = {
    packages: {
      p: { versions: [{ version: '1.0.0-alpha.1' }] },
    },
    roots: { p: '*' },
  }
  t.equal(solve(input).status, 'unsat', 'prerelease excluded by default')
  const r = solve({ ...input, options: { includePrerelease: true } })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { p: '1.0.0-alpha.1' })
  t.end()
})

t.test('prerelease candidates are skipped without the option', (t) => {
  const r = solve({
    packages: {
      p: { versions: [{ version: '2.0.0-alpha.1' }, { version: '1.0.0' }] },
    },
    roots: { p: '*' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { p: '1.0.0' })
  t.end()
})

t.test('budget that is exactly sufficient still solves', (t) => {
  const full = solve(backtrackInput())
  t.equal(full.status, 'solved')
  const exact = solve({ ...backtrackInput(), options: { budget: full.attempts } })
  t.same(exact, full, 'budget equal to the needed attempts solves identically')
  const short = solve({ ...backtrackInput(), options: { budget: full.attempts - 1 } })
  t.equal(short.status, 'budget')
  t.equal(short.attempts, full.attempts)
  t.equal(short.budget, full.attempts - 1)
  t.end()
})

t.test('budget of zero allows no candidate attempt', (t) => {
  const r = solve({ ...backtrackInput(), options: { budget: 0 } })
  t.equal(r.status, 'budget')
  t.end()
})

t.test('rolled back candidates leave no constraints behind', (t) => {
  const r = solve({
    packages: {
      app: {
        versions: [
          { version: '2.0.0', dependencies: { extra: '^1.0.0', lib: '^2.0.0' } },
          { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
        ],
      },
      extra: { versions: [{ version: '1.0.0' }] },
      lib: { versions: [{ version: '2.0.0' }, { version: '1.5.0' }] },
    },
    roots: { app: '>=1.0.0', lib: '^1.0.0' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { app: '1.0.0', lib: '1.5.0' })
  t.notOk('extra' in r.assignment,
    'extra was only reachable through the abandoned app@2.0.0 branch')
  t.end()
})

t.test('unreachable packages are never assigned', (t) => {
  const r = solve({
    packages: {
      app: { versions: [{ version: '1.0.0' }] },
      unused: { versions: [{ version: '3.0.0' }] },
    },
    roots: { app: '^1.0.0' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { app: '1.0.0' })
  t.end()
})

t.test('build metadata is kept as the original version identifier', (t) => {
  const r = solve({
    packages: {
      p: { versions: [{ version: '1.0.0+build.5' }] },
    },
    roots: { p: '^1.0.0' },
  })
  t.equal(r.status, 'solved')
  t.same(r.assignment, { p: '1.0.0+build.5' })
  t.end()
})

t.test('input object is not modified', (t) => {
  const input = deepFreeze(backtrackInput())
  const r = solve(input)
  t.equal(r.status, 'solved')
  t.end()
})

t.test('rejects invalid input', (t) => {
  t.throws(() => solve(null), /input must be an object/)
  t.throws(() => solve({ packages: {}, roots: { ghost: '^1.0.0' } }),
    /unknown package/, 'unknown root package')
  t.throws(() => solve({
    packages: {
      app: { versions: [{ version: '1.0.0', dependencies: { ghost: '^1.0.0' } }] },
    },
    roots: { app: '^1.0.0' },
  }), /unknown package/, 'unknown dependency package')
  t.throws(() => solve({
    packages: { app: { versions: [{ version: '1.0' }] } },
    roots: { app: '^1.0.0' },
  }), /invalid version/, 'invalid candidate version')
  t.throws(() => solve({
    packages: {
      app: { versions: [{ version: '1.0.0', dependencies: { lib: 'not a range' } }] },
      lib: { versions: [{ version: '1.0.0' }] },
    },
    roots: { app: '^1.0.0' },
  }), /not a valid range/, 'invalid dependency range')
  t.throws(() => solve({
    packages: {
      lib: { versions: [{ version: '1.0.0' }, { version: '1.0.0+build.1' }] },
    },
    roots: { lib: '^1.0.0' },
  }), /duplicate/, 'semantically equal duplicate candidates')
  t.throws(() => solve({ packages: null, roots: {} }),
    /packages must be an object/)
  t.throws(() => solve({ packages: {}, roots: null }),
    /roots must be an object/)
  t.throws(() => solve({ packages: { app: {} }, roots: {} }),
    /versions array/)
  t.throws(() => solve({
    packages: { app: { versions: [{}] } },
    roots: {},
  }), /without a version string/)
  t.throws(() => solve({
    packages: { app: { versions: [{ version: '1.0.0', dependencies: 7 }] } },
    roots: {},
  }), /invalid dependencies/)
  t.throws(() => solve({
    packages: {
      app: { versions: [{ version: '1.0.0', dependencies: { lib: 7 } }] },
      lib: { versions: [{ version: '1.0.0' }] },
    },
    roots: {},
  }), /must be a range string/)
  for (const budget of [-1, 1.5, '10']) {
    t.throws(() => solve({
      packages: { app: { versions: [{ version: '1.0.0' }] } },
      roots: { app: '^1.0.0' },
      options: { budget },
    }), /budget/, 'invalid budget: ' + JSON.stringify(budget))
  }
  t.end()
})

// --- exhaustive cross-check on small random catalogs ---

const mulberry32 = (seed) => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let z = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296
}

const versionPool = ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0', '3.0.0']
const rangePool = ['*', '^1.0.0', '^1.1.0', '^2.0.0', '>=1.0.0 <3.0.0', '<2.0.0']

const genCase = (rand) => {
  const names = ['a', 'b', 'c', 'd'].slice(0, 2 + Math.floor(rand() * 3))
  const packages = {}
  for (const name of names) {
    const nv = 1 + Math.floor(rand() * 3)
    const used = new Set()
    const versions = []
    while (versions.length < nv) {
      const v = versionPool[Math.floor(rand() * versionPool.length)]
      if (used.has(v)) {
        continue
      }
      used.add(v)
      const dependencies = {}
      for (const dep of names) {
        if (dep !== name && rand() < 0.4) {
          dependencies[dep] = rangePool[Math.floor(rand() * rangePool.length)]
        }
      }
      versions.push(rand() < 0.5 ? { version: v, dependencies } : { version: v })
    }
    packages[name] = { versions }
  }
  const roots = {}
  for (const name of names) {
    if (rand() < 0.6) {
      roots[name] = rangePool[Math.floor(rand() * rangePool.length)]
    }
  }
  if (Object.keys(roots).length === 0) {
    roots[names[0]] = '*'
  }
  return { packages, roots }
}

// reference model: enumerate every combination of one candidate version
// per package, compute the reachable set, and check every constraint
const bruteForceSat = (input, options) => {
  const names = Object.keys(input.packages)
  const ranges = new Map()
  const getRange = (raw) => {
    if (!ranges.has(raw)) {
      ranges.set(raw, new Range(raw, options))
    }
    return ranges.get(raw)
  }
  const sel = {}
  let sat = false
  const check = () => {
    // every root package must be selected and satisfy its root range
    for (const [name, raw] of Object.entries(input.roots)) {
      const v = sel[name]
      if (v === undefined || !getRange(raw).test(new SemVer(v))) {
        return
      }
    }
    // walk the reachable set from the roots
    const seen = new Set()
    const queue = Object.keys(input.roots)
    while (queue.length) {
      const name = queue.shift()
      if (seen.has(name)) {
        continue
      }
      seen.add(name)
      const v = sel[name]
      if (v === undefined) {
        return // reachable but not selected
      }
      const cand = input.packages[name].versions.find((x) => x.version === v)
      for (const [dep, raw] of Object.entries(cand.dependencies || {})) {
        const dv = sel[dep]
        if (dv === undefined || !getRange(raw).test(new SemVer(dv))) {
          return
        }
        queue.push(dep)
      }
    }
    sat = true
  }
  const walk = (i) => {
    if (sat) {
      return
    }
    if (i === names.length) {
      check()
      return
    }
    const name = names[i]
    for (const cand of input.packages[name].versions) {
      sel[name] = cand.version
      walk(i + 1)
    }
    delete sel[name]
    walk(i + 1) // package not selected at all
  }
  walk(0)
  return sat
}

t.test('matches exhaustive search on small random catalogs', (t) => {
  const rand = mulberry32(20260923)
  const mismatches = []
  for (let i = 0; i < 300; i++) {
    const input = genCase(rand)
    const includePrerelease = i % 3 === 0
    const options = { includePrerelease }
    const r = solve({ ...input, options })
    const expected = bruteForceSat(input, options)
    const got = r.status === 'solved'
    if (got !== expected) {
      mismatches.push({ i, expected, got, input })
      continue
    }
    if (got) {
      // the returned assignment must itself be a valid selection
      const checkInput = {
        packages: input.packages,
        roots: r.assignment,
      }
      // every assigned version satisfies every root of the original
      // input and the assignment only covers reachable packages;
      // bruteForceSat with the assignment as roots re-validates it
      for (const [name, raw] of Object.entries(input.roots)) {
        if (!new Range(raw, options).test(new SemVer(r.assignment[name]))) {
          mismatches.push({ i, why: 'root range violated', input, r })
        }
      }
      if (!bruteForceSat(checkInput, options)) {
        mismatches.push({ i, why: 'assignment not self-consistent', input, r })
      }
    } else if (r.status !== 'unsat' || !r.conflict || !r.conflict.path) {
      mismatches.push({ i, why: 'unsat without conflict report', input, r })
    }
  }
  t.same(mismatches, [])
  t.end()
})

t.test('deterministic across reruns and key reordering on random catalogs', (t) => {
  const rand = mulberry32(42)
  const mismatches = []
  for (let i = 0; i < 100; i++) {
    const input = genCase(rand)
    const a = solve(input)
    const b = solve(input)
    const c = solve(reorder(input))
    if (JSON.stringify(a) !== JSON.stringify(b) ||
        JSON.stringify(a) !== JSON.stringify(c)) {
      mismatches.push({ i, a, b, c })
    }
  }
  t.same(mismatches, [])
  t.end()
})
