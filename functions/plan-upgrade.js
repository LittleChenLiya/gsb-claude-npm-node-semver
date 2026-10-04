'use strict'

const SemVer = require('../classes/semver')
const Range = require('../classes/range')

// Plan the shortest allowed upgrade chain from a start version to a
// target range, walking only explicitly allowed edges between published
// versions, while avoiding forbidden version ranges.
//
// planUpgrade({
//   versions: ['1.0.0', '1.1.0', '1.2.0', '2.0.0'], // published versions
//   edges: [['1.0.0', '1.1.0'], ...],               // allowed upgrade edges
//   from: '1.0.0',                                  // start version
//   to: '^2.0.0',                                   // target range
//   forbidden: ['1.2.x'],                           // forbidden ranges
//   options: { includePrerelease: false },          // semver options
// })
//
// Edges may be [from, to] pairs or { from, to } objects.  Only explicit
// edges are traversable: no edge, no jump.  Forbidden ranges are matched
// with normal semver range rules, so they never match prereleases unless
// options.includePrerelease is set, and a forbidden version can be used
// neither as an intermediate stop nor as the resolved target.  Among
// chains of the same (minimal) length the one whose full version sequence
// is lowest by semver order is chosen, so the result is stable.

const normalizeEdge = (edge, index) => {
  const raw = Array.isArray(edge) ? { from: edge[0], to: edge[1] } : edge
  if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
    throw new TypeError(
      `planUpgrade: edge #${index} must be a [from, to] pair or a { from, to } object`)
  }
  return { from: raw.from, to: raw.to }
}

// compare two version sequences element by element in full semver order
const compareChains = (a, b) => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const c = a[i].sv.compare(b[i].sv)
    if (c !== 0) {
      return c
    }
  }
  return a.length - b.length
}

const planUpgrade = (spec = {}) => {
  const {
    versions = [],
    edges = [],
    from,
    to,
    forbidden = [],
    options = {},
  } = spec

  if (typeof from !== 'string' || !from) {
    throw new TypeError('planUpgrade: a "from" start version is required')
  }
  if (typeof to !== 'string' || !to) {
    throw new TypeError('planUpgrade: a "to" target range is required')
  }

  const targetRange = new Range(to, options)
  const forbiddenRanges = forbidden.map((f) => new Range(f, options))

  // published versions, deduped by canonical form, ascending
  const published = new Map()
  for (const v of versions) {
    const sv = new SemVer(v, options)
    if (!published.has(sv.version)) {
      published.set(sv.version, sv)
    }
  }
  const sorted = [...published.values()].sort((a, b) => a.compare(b))

  const isForbidden = (sv) => forbiddenRanges.some((r) => r.test(sv))

  const fail = (reason, explanation, extra) => ({
    ok: false,
    reason,
    from,
    to,
    chain: null,
    steps: null,
    explanation,
    ...extra,
  })

  const start = published.get(new SemVer(from, options).version)
  if (!start) {
    return fail('no-start',
      `start version ${from} is not one of the published versions`)
  }

  const allTargets = sorted.filter((sv) => targetRange.test(sv))
  if (allTargets.length === 0) {
    return fail('no-target',
      `no published version satisfies target range "${to}"`)
  }
  const targets = allTargets.filter((sv) => !isForbidden(sv))
  if (targets.length === 0) {
    const blocked = allTargets.map((sv) => {
      const hit = forbiddenRanges.find((r) => r.test(sv))
      return `${sv.version} (forbidden by "${hit.raw}")`
    })
    return fail('target-forbidden',
      `every version satisfying target range "${to}" is forbidden: ` +
      blocked.join(', '),
      { forbiddenTargets: allTargets.map((sv) => sv.version) })
  }
  const targetSet = new Set(targets.map((sv) => sv.version))

  // adjacency from explicit allowed edges only; edges mentioning
  // unpublished versions are dead ends and are dropped
  const adjacency = new Map()
  edges.forEach((rawEdge, index) => {
    const edge = normalizeEdge(rawEdge, index)
    const fromSv = published.get(new SemVer(edge.from, options).version)
    const toSv = published.get(new SemVer(edge.to, options).version)
    if (!fromSv || !toSv) {
      return
    }
    const key = fromSv.version
    if (!adjacency.has(key)) {
      adjacency.set(key, [])
    }
    adjacency.get(key).push({ from: key, to: toSv.version, edgeIndex: index })
  })
  // deterministic traversal order: lowest target version, then edge order
  for (const list of adjacency.values()) {
    list.sort((a, b) =>
      published.get(a.to).compare(published.get(b.to)) || a.edgeIndex - b.edgeIndex)
  }

  const toResult = (chain) => {
    const steps = chain.slice(1).map((node) => ({
      from: node.edge.from,
      to: node.edge.to,
      edge: { from: node.edge.from, to: node.edge.to },
      edgeIndex: node.edge.edgeIndex,
    }))
    const target = chain[chain.length - 1].sv.version
    const narrative = steps.length === 0
      ? `start version ${start.version} already satisfies target range "${to}"`
      : `start at ${start.version}; ` +
        steps.map((s, i) =>
          `step ${i + 1}: ${s.from} -> ${s.to} via allowed edge #${s.edgeIndex}` +
          ` (${s.edge.from} -> ${s.edge.to})`).join('; ') +
        `; reached ${target} in ${steps.length} step(s)`
    return {
      ok: true,
      reason: null,
      from,
      to,
      target,
      chain: chain.map((node) => node.sv.version),
      steps,
      explanation: narrative,
    }
  }

  // zero-step plan: the start version is itself an allowed target
  if (targetSet.has(start.version)) {
    return toResult([{ sv: start, edge: null }])
  }

  // breadth-first search; cyclic edges are harmless because every version
  // is settled at most once, at its minimal depth, with the chain that is
  // lowest in full version order
  const settled = new Map([[start.version, [{ sv: start, edge: null }]]])
  let frontier = [start.version]
  const found = []
  while (frontier.length > 0 && found.length === 0) {
    const next = new Map()
    for (const version of frontier) {
      const chain = settled.get(version)
      for (const edge of adjacency.get(version) || []) {
        if (settled.has(edge.to)) {
          continue
        }
        const toSv = published.get(edge.to)
        if (isForbidden(toSv)) {
          continue
        }
        const candidate = [...chain, { sv: toSv, edge }]
        const prev = next.get(edge.to)
        if (!prev || compareChains(candidate, prev) < 0) {
          next.set(edge.to, candidate)
        }
        if (targetSet.has(edge.to)) {
          found.push(candidate)
        }
      }
    }
    if (found.length === 0) {
      for (const [version, chain] of next) {
        settled.set(version, chain)
      }
      frontier = [...next.keys()]
    }
  }

  if (found.length > 0) {
    found.sort(compareChains)
    return toResult(found[0])
  }

  const reachable = [...settled.keys()]
  const blockedByForbidden = sorted
    .filter((sv) => isForbidden(sv))
    .filter((sv) => reachable.some((v) =>
      (adjacency.get(v) || []).some((edge) => edge.to === sv.version)))
    .map((sv) => sv.version)
  const detail = blockedByForbidden.length > 0
    ? `; forbidden version(s) ${blockedByForbidden.join(', ')} block the way`
    : ''
  return fail('unreachable',
    `no allowed-edge chain from ${from} reaches any version satisfying ` +
    `"${to}"; reachable versions: ${reachable.join(', ')}${detail}`,
    { reachable, blockedByForbidden })
}

module.exports = planUpgrade
