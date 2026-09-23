'use strict'

// Offline dependency version solver.
//
// Given a fixed catalog of candidate versions per package, the required
// dependency ranges of each candidate, and a set of root dependencies,
// pick at most one version per package so that every reachable constraint
// is satisfied. Only packages reachable from the roots are assigned.
// There is no nested/node_modules-style installation and no peer
// dependency modeling: one global version per package.
//
// Membership tests reuse Range and SemVer from this repository. The
// includePrerelease option is forwarded to every Range. Build metadata
// is ignored for all comparisons and only kept as the original version
// identifier of a candidate.

const SemVer = require('../classes/semver.js')
const Range = require('../classes/range.js')

const ROOT_SOURCE = '<root>'

const fail = (msg) => {
  throw new Error('semver-solver: ' + msg)
}

const parseRange = (raw, options, what) => {
  if (typeof raw !== 'string') {
    fail(what + ' must be a range string, got: ' + String(raw))
  }
  try {
    return new Range(raw, options)
  } catch (er) {
    fail(what + ' is not a valid range: ' + raw)
  }
}

// Validate the input and build internal copies. The input object is
// never mutated. Everything is sorted so that the result and the
// diagnostics do not depend on the key order of the input object.
const normalize = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('input must be an object')
  }
  const { packages, roots } = input
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    fail('input.packages must be an object')
  }
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    fail('input.roots must be an object')
  }
  const opts = input.options || {}
  const options = { includePrerelease: !!opts.includePrerelease }
  const budget = opts.budget === undefined ? Infinity : opts.budget
  if (budget !== Infinity) {
    if (typeof budget !== 'number' || budget < 0 || Math.floor(budget) !== budget) {
      fail('options.budget must be a non-negative integer')
    }
  }

  const catalog = new Map()
  for (const name of Object.keys(packages).sort()) {
    const entry = packages[name]
    const versions = entry && entry.versions
    if (!Array.isArray(versions)) {
      fail('package "' + name + '" must provide a versions array')
    }
    const candidates = []
    for (const v of versions) {
      const raw = v && v.version
      if (typeof raw !== 'string') {
        fail('package "' + name + '" has a candidate without a version string')
      }
      let parsed
      try {
        parsed = new SemVer(raw)
      } catch (er) {
        fail('package "' + name + '" has an invalid version: ' + raw)
      }
      const deps = []
      const depMap = v.dependencies || {}
      if (typeof depMap !== 'object' || Array.isArray(depMap)) {
        fail('package "' + name + '" version ' + raw + ' has invalid dependencies')
      }
      for (const depName of Object.keys(depMap).sort()) {
        deps.push({
          name: depName,
          rangeRaw: depMap[depName],
          range: parseRange(depMap[depName], options,
            'dependency "' + depName + '" of "' + name + '@' + raw + '"'),
        })
      }
      candidates.push({ raw, parsed, deps })
    }
    // highest version first; build metadata is ignored for ordering
    candidates.sort((a, b) => b.parsed.compare(a.parsed))
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].parsed.compare(candidates[i - 1].parsed) === 0) {
        fail('package "' + name + '" has duplicate candidates that are ' +
          'semantically equal: ' + candidates[i - 1].raw + ' and ' + candidates[i].raw)
      }
    }
    catalog.set(name, candidates)
  }

  for (const [name, candidates] of catalog) {
    for (const cand of candidates) {
      for (const dep of cand.deps) {
        if (!catalog.has(dep.name)) {
          fail('"' + name + '@' + cand.raw + '" depends on unknown package "' + dep.name + '"')
        }
      }
    }
  }

  const rootConstraints = []
  for (const name of Object.keys(roots).sort()) {
    if (!catalog.has(name)) {
      fail('root dependency refers to unknown package "' + name + '"')
    }
    rootConstraints.push({
      name,
      rangeRaw: roots[name],
      range: parseRange(roots[name], options, 'root dependency "' + name + '"'),
    })
  }

  return { catalog, rootConstraints, budget }
}

const solve = (input) => {
  const { catalog, rootConstraints, budget } = normalize(input)

  // active constraints per package, in insertion order
  const constraints = new Map()
  for (const name of catalog.keys()) {
    constraints.set(name, [])
  }
  const assignment = new Map()
  let attempts = 0
  let conflict = null
  let conflictGen = 0

  for (const rc of rootConstraints) {
    constraints.get(rc.name).push({
      range: rc.range,
      rangeRaw: rc.rangeRaw,
      source: ROOT_SOURCE,
      sourceName: null,
    })
  }

  // Chain of active constraints from a root down to `name`. Every entry
  // corresponds to a constraint that is active right now, so the path can
  // be verified against the input catalog.
  const buildPath = (name) => {
    const chain = []
    const seen = new Set([name])
    let current = name
    for (;;) {
      const cons = constraints.get(current)
      const c = cons.find((x) => x.sourceName !== null) || cons[0]
      chain.push({ from: c.source, package: current, range: c.rangeRaw })
      if (c.sourceName === null || seen.has(c.sourceName)) {
        break
      }
      seen.add(c.sourceName)
      current = c.sourceName
    }
    return chain.reverse()
  }

  const recordConflict = (name, reason) => {
    conflictGen++
    const chosen = assignment.get(name)
    conflict = {
      package: name,
      version: chosen ? chosen.raw : null,
      reason,
      constraints: constraints.get(name).map((c) => ({
        range: c.rangeRaw,
        source: c.source,
      })),
      path: buildPath(name),
    }
    const vs = chosen ? ' (assigned ' + chosen.raw + ')' : ''
    const cs = conflict.constraints
      .map((c) => c.range + ' required by ' + c.source).join(', ')
    conflict.message =
      'cannot satisfy constraints on "' + name + '"' + vs + ': ' + cs + '. ' + reason
  }

  // Depth-first search with chronological backtracking.
  // Returns true when solved, 'budget' when the attempt budget ran out,
  // and false when the current branch is infeasible.
  const decide = () => {
    let next = null
    for (const [name, cons] of constraints) {
      if (cons.length > 0 && !assignment.has(name) && (next === null || name < next)) {
        next = name
      }
    }
    if (next === null) {
      return true
    }
    const gen0 = conflictGen
    const cons = constraints.get(next)
    for (const cand of catalog.get(next)) {
      attempts++
      if (attempts > budget) {
        return 'budget'
      }
      if (!cons.every((c) => c.range.test(cand.parsed))) {
        continue
      }
      assignment.set(next, cand)
      const added = []
      let ok = true
      for (const dep of cand.deps) {
        const entry = {
          range: dep.range,
          rangeRaw: dep.rangeRaw,
          source: next + '@' + cand.raw,
          sourceName: next,
        }
        constraints.get(dep.name).push(entry)
        added.push([dep.name, entry])
        const chosen = assignment.get(dep.name)
        if (chosen && !dep.range.test(chosen.parsed)) {
          recordConflict(dep.name,
            '"' + next + '@' + cand.raw + '" requires "' + dep.name + '@' + dep.rangeRaw +
            '" but ' + chosen.raw + ' is selected')
          ok = false
          break
        }
      }
      if (ok) {
        const r = decide()
        if (r === true || r === 'budget') {
          return r
        }
      }
      // undo exactly the constraints this candidate introduced, so an
      // abandoned branch cannot pollute the siblings explored after it
      for (const [n, e] of added) {
        const list = constraints.get(n)
        list.splice(list.indexOf(e), 1)
      }
      assignment.delete(next)
    }
    if (conflictGen === gen0) {
      // every candidate failed on the package's own constraints, or the
      // package has no candidates at all
      recordConflict(next, 'no candidate version satisfies all constraints')
    }
    return false
  }

  const r = decide()
  if (r === 'budget') {
    return { status: 'budget', attempts, budget }
  }
  if (r === false) {
    return { status: 'unsat', attempts, conflict }
  }
  const picked = {}
  for (const name of [...assignment.keys()].sort()) {
    picked[name] = assignment.get(name).raw
  }
  return { status: 'solved', attempts, assignment: picked }
}

module.exports = solve
