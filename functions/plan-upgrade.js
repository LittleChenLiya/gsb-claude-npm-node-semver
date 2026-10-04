'use strict'

const compare = require('./compare')
const valid = require('./valid')
const Range = require('../classes/range')

const DEFAULTS = { loose: false, includePrerelease: false }

const isVersion = (v, options) => typeof v === 'string' && !!valid(v, options)

// Lexicographic comparison of two same-length chains using semver
// precedence at each position.  Returns -1, 0 or 1 just like compare().
const cmpChain = (a, b) => {
  const len = a.length < b.length ? a.length : b.length
  for (let i = 0; i < len; i++) {
    const c = compare(a[i], b[i])
    if (c) {
      return c
    }
  }
  return a.length - b.length
}

const buildResult = (chain, range, disabled, startDisabled) => {
  const edges = []
  const steps = []
  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1]
    const to = chain[i]
    edges.push([from, to])
    steps.push({
      n: i,
      from,
      to,
      edge: [from, to],
      text: `第${i}步: ${from} -> ${to}（沿允许边 ${from} -> ${to}）`,
    })
  }
  const disabledNote = disabled.length
    ? `禁用范围 ${disabled.map(r => r.raw).join('、')} 中的版本均不可途经或作为终点；`
    : ''
  const startNote = startDisabled
    ? '起点位于禁用范围内（起点允许停留，但不可作为升级终点）；'
    : ''
  return {
    ok: true,
    start: chain[0],
    target: chain[chain.length - 1],
    targetRange: range.raw,
    path: chain.slice(),
    edges,
    steps,
    explanation:
      `最短升级链共 ${chain.length - 1} 步: ${chain.join(' -> ')}。` +
      `${disabledNote}${startNote}` +
      `每一步均沿显式声明的允许边前进，终点 ${chain[chain.length - 1]} ` +
      `满足目标范围 ${range.raw}。`,
  }
}

const failResult = (reason, start, range, disabled, extra) => ({
  ok: false,
  reason,
  start,
  targetRange: range.raw,
  disabledRanges: disabled.map(r => r.raw),
  explanation: extra,
})

/**
 * Plan the shortest feasible upgrade chain.
 *
 * Only explicitly declared allowed edges may be traversed.  Version
 * comparison and prerelease matching follow semver rules: a prerelease
 * version only satisfies a range when the range names a prerelease of the
 * same [major, minor, patch] tuple (or `includePrerelease` is set).
 * Disabled versions can neither be intermediate stops nor targets.
 * Among chains of the same length the chain is selected stably by full
 * version order (semver precedence at each position).
 *
 * @param {string[]} versions  published versions
 * @param {Array<[string, string]>} edges  directed allowed edges [from, to]
 * @param {string} start  starting version (must be a published version)
 * @param {string} targetRange  semver range the upgrade must end in
 * @param {string[]} [disabledRanges]  ranges that must not be used
 * @param {{loose?: boolean, includePrerelease?: boolean}} [options]
 * @returns {{ok: true, start: string, target: string, targetRange: string,
 *            path: string[], edges: Array<[string, string]>,
 *            steps: Array<object>, explanation: string}
 *          | {ok: false, reason: 'no-target'|'blocked', start: string,
 *            targetRange: string, disabledRanges: string[],
 *            explanation: string}}
 */
const planUpgrade = (versions, edges, start, targetRange, disabledRanges, options) => {
  options = Object.assign({}, DEFAULTS, options)
  const opts = { loose: !!options.loose, includePrerelease: !!options.includePrerelease }

  if (!Array.isArray(versions)) {
    throw new TypeError('versions must be an array of version strings')
  }
  const published = new Set()
  for (const v of versions) {
    if (!isVersion(v, opts)) {
      throw new TypeError(`Invalid version: ${v}`)
    }
    published.add(v)
  }

  if (!isVersion(start, opts)) {
    throw new TypeError(`Invalid start version: ${start}`)
  }
  if (!published.has(start)) {
    throw new TypeError(`Start version ${start} is not a published version`)
  }

  let range
  try {
    range = new Range(targetRange, opts)
  } catch (er) {
    throw new TypeError(`Invalid target range: ${targetRange}`)
  }

  const disabled = []
  if (disabledRanges !== undefined && disabledRanges !== null) {
    if (!Array.isArray(disabledRanges)) {
      throw new TypeError('disabledRanges must be an array of ranges')
    }
    for (const r of disabledRanges) {
      try {
        disabled.push(new Range(r, opts))
      } catch (er) {
        throw new TypeError(`Invalid disabled range: ${r}`)
      }
    }
  }
  const isDisabled = v => disabled.some(r => r.test(v))

  // Build the adjacency graph from explicitly declared allowed edges only.
  // No edge is ever inferred from version ordering.
  const adj = new Map()
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2) {
      throw new TypeError('Each allowed edge must be a [from, to] pair')
    }
    const [from, to] = e
    if (!isVersion(from, opts)) {
      throw new TypeError(`Invalid edge version: ${from}`)
    }
    if (!isVersion(to, opts)) {
      throw new TypeError(`Invalid edge version: ${to}`)
    }
    if (!published.has(from)) {
      throw new TypeError(`Edge version ${from} is not a published version`)
    }
    if (!published.has(to)) {
      throw new TypeError(`Edge version ${to} is not a published version`)
    }
    if (!adj.has(from)) {
      adj.set(from, new Set())
    }
    adj.get(from).add(to)
  }

  const candidates = [...published].filter(v => range.test(v))
  if (!candidates.length) {
    return failResult(
      'no-target', start, range, disabled,
      `目标范围 ${range.raw} 不匹配任何已发布版本，不存在升级终点。`)
  }

  // Zero-step case: the start already satisfies the target range.
  if (range.test(start)) {
    if (isDisabled(start)) {
      return failResult(
        'blocked', start, range, disabled,
        `起点 ${start} 已满足目标范围 ${range.raw}，但起点位于禁用范围内，不能作为升级终点。`)
    }
    return {
      ok: true,
      start,
      target: start,
      targetRange: range.raw,
      path: [start],
      edges: [],
      steps: [],
      explanation: `起点 ${start} 已满足目标范围 ${range.raw}，无需升级（0 步）。`,
    }
  }

  // BFS over explicit edges, layer by layer.  `best` holds the shortest
  // chain to every finalized version; among equal-length chains the
  // lexicographically smallest one (full version order) is kept.
  const best = new Map()
  best.set(start, [start])
  let frontier = [start]
  const startDisabled = isDisabled(start)

  while (frontier.length) {
    const next = new Map()
    for (const v of frontier.sort(compare)) {
      const neighbors = adj.get(v)
      if (!neighbors) {
        continue
      }
      for (const w of [...neighbors].sort(compare)) {
        if (best.has(w)) {
          // A shorter (or already finalized) chain to w exists; cycles
          // back to visited versions are ignored.
          continue
        }
        if (isDisabled(w)) {
          // Disabled versions cannot be intermediate stops or targets.
          continue
        }
        const candidate = best.get(v).concat(w)
        const existing = next.get(w)
        if (!existing || cmpChain(candidate, existing) < 0) {
          next.set(w, candidate)
        }
      }
    }

    for (const w of next.keys()) {
      best.set(w, next.get(w))
    }

    // The first layer that reaches a target gives the shortest length.
    const hits = [...next.keys()].filter(w => range.test(w))
    if (hits.length) {
      hits.sort((a, b) => cmpChain(next.get(a), next.get(b)))
      return buildResult(next.get(hits[0]), range, disabled, startDisabled)
    }

    frontier = [...next.keys()]
  }

  return failResult(
    'blocked', start, range, disabled,
    `目标范围 ${range.raw} 存在匹配的已发布版本，但从 ${start} 出发没有可行的显式允许边路径到达（途经版本可能被禁用或缺少允许边）。`)
}

module.exports = planUpgrade
