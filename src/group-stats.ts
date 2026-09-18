// Pure grouping/aggregation of throughput log entries for the TUI sidebar.
//
// A GroupTotals is a flat running-sum bucket. `aggregateBy` builds one per key
// (agent, session, model, ...) in a single pass, and the avg*/hitRateOf helpers
// read it back. Everything here is dependency-free apart from `cacheHitRate`,
// which the hit rate deliberately reuses so grouped rows and the session-wide
// cache line can never drift apart.

import { cacheHitRate } from "./cache-rate.js"

export interface GroupEntryInput {
  agent: string
  sessionID: string
  model: string
  ttft_ms: number | null
  tps: number | null
  latency_ms: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface GroupTotals {
  count: number
  ttftSum: number
  tpsSum: number
  latencySum: number
  input: number
  output: number
  reasoning: number
  read: number
  write: number
  cost: number
}

export function emptyTotals(): GroupTotals {
  return {
    count: 0,
    ttftSum: 0,
    tpsSum: 0,
    latencySum: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    read: 0,
    write: 0,
    cost: 0,
  }
}

export function accumulate(t: GroupTotals, e: GroupEntryInput): void {
  t.count += 1
  // Deliberate parity with the pre-existing sidebar averaging: a null
  // TTFT/TPS/latency contributes 0 to the sum, so it drags the group average
  // down rather than being excluded. This is NOT a bug fix -- existing model
  // rows average the same way. Switching to non-null-only averaging is a
  // separate future change that must not be smuggled in here.
  t.ttftSum += e.ttft_ms ?? 0
  t.tpsSum += e.tps ?? 0
  t.latencySum += e.latency_ms ?? 0
  t.input += e.inputTokens
  t.output += e.outputTokens
  t.reasoning += e.reasoningTokens
  t.read += e.cacheReadTokens
  t.write += e.cacheWriteTokens
  t.cost += e.cost
}

export function aggregateBy(
  entries: readonly GroupEntryInput[],
  keyOf: (e: GroupEntryInput) => string
): Map<string, GroupTotals> {
  const groups = new Map<string, GroupTotals>()
  for (const e of entries) {
    const key = keyOf(e)
    let totals = groups.get(key)
    if (totals === undefined) {
      totals = emptyTotals()
      groups.set(key, totals)
    }
    accumulate(totals, e)
  }
  return groups
}

export function avgTTFT(t: GroupTotals): number | null {
  return t.count === 0 ? null : t.ttftSum / t.count
}

export function avgTPS(t: GroupTotals): number | null {
  return t.count === 0 ? null : t.tpsSum / t.count
}

export function avgLatency(t: GroupTotals): number | null {
  return t.count === 0 ? null : t.latencySum / t.count
}

export function hitRateOf(t: GroupTotals): number | null {
  // Sum the raw prompt counters first, then divide once. Averaging per-entry
  // rates would weight a 10-token request the same as a 10k-token one.
  return cacheHitRate({ read: t.read, input: t.input, write: t.write })
}
