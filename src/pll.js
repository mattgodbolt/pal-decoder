// Horizontal PLL. Takes a stream of (possibly noisy, possibly missing)
// sync-edge sample positions and produces a smoothed per-line estimate
// of line start + line period.
//
// Second-order digital PLL with a PI loop filter:
//   error    = observed - predicted
//   position = predicted + Kp · error        (proportional: snap toward obs)
//   period  += Kf · error                    (integrator: track frequency drift)
//   predicted_next = position + period
//
// Default gains give a loop bandwidth of a few hundred Hz at the 15.625
// kHz line rate — responsive enough to recover from a glitch in under ten
// lines, slow enough to average out sub-sample jitter.

import { LINE_SAMPLES } from './timing.js'

const DEFAULT_KP = 0.25
const DEFAULT_KF = 0.02

export class HorizontalPLL {
  constructor({
    period = LINE_SAMPLES,
    position = 0,
    kp = DEFAULT_KP,
    kf = DEFAULT_KF,
    // Observations further than this fraction of a period from the
    // prediction are rejected as spurious (or as the wrong line).
    lockToleranceFrac = 0.25,
    // How many consecutive missed / rejected lines before we declare
    // the PLL out of lock. Within this budget the loop free-runs.
    unlockAfterMissed = 4,
  } = {}) {
    this.period = period
    this.predicted = position
    this.kp = kp
    this.kf = kf
    this.lockToleranceFrac = lockToleranceFrac
    this.unlockAfterMissed = unlockAfterMissed
    this.locked = false
    this.missed = 0
  }

  /**
   * Advance the loop by one line.
   * @param {number|null} observed  sample index of this line's sync edge,
   *                                or null if no observation available
   *                                (glitch, dropout).
   * @returns {{ position: number, period: number, locked: boolean,
   *             error: number|null, used: boolean }}
   */
  step(observed) {
    let error = null
    let position = this.predicted
    let used = false
    if (observed !== null && observed !== undefined) {
      const e = observed - this.predicted
      if (Math.abs(e) < this.period * this.lockToleranceFrac) {
        error = e
        position = this.predicted + this.kp * e
        this.period += this.kf * e
        this.missed = 0
        this.locked = true
        used = true
      }
    }
    if (!used) {
      this.missed += 1
      if (this.missed > this.unlockAfterMissed) this.locked = false
    }
    this.predicted = position + this.period
    return { position, period: this.period, locked: this.locked, error, used }
  }
}

/**
 * Initialise a PLL from the first several detected edges. Uses median
 * inter-edge spacing for the period estimate — robust against one or two
 * spurious edges at the start.
 */
export function acquirePLL(edges, opts = {}) {
  if (edges.length < 2) throw new Error('need at least 2 edges to acquire')
  const diffs = []
  const maxDiffs = Math.min(edges.length - 1, 20)
  for (let i = 1; i <= maxDiffs; i++) diffs.push(edges[i] - edges[i - 1])
  diffs.sort((a, b) => a - b)
  const period = diffs[Math.floor(diffs.length / 2)]
  return new HorizontalPLL({ period, position: edges[0], ...opts })
}

/**
 * Walk an ordered list of detected sync edges and produce one smoothed
 * line-start estimate per expected line. If the next edge is more than
 * one period-tolerance past the PLL's prediction, we treat that line as
 * missed (PLL free-runs) without consuming the edge.
 */
export function trackLines(edges, nLines, opts = {}) {
  const pll = acquirePLL(edges, opts)
  const results = []
  let ei = 0
  for (let line = 0; line < nLines; line++) {
    let observed = null
    const tol = pll.period * pll.lockToleranceFrac
    // Discard edges that fall well before our prediction (stragglers from
    // a prior free-run).
    while (ei < edges.length && edges[ei] < pll.predicted - tol) ei++
    if (ei < edges.length && edges[ei] < pll.predicted + tol) {
      observed = edges[ei]
      ei++
    }
    results.push(pll.step(observed))
  }
  return results
}
