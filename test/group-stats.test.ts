import { describe, test, expect } from "bun:test"
import {
  accumulate,
  aggregateBy,
  avgLatency,
  avgTPS,
  avgTTFT,
  emptyTotals,
  hitRateOf,
  type GroupEntryInput,
} from "../src/group-stats.js"

function entry(overrides: Partial<GroupEntryInput> = {}): GroupEntryInput {
  return {
    agent: "build",
    sessionID: "sess-1",
    model: "anthropic/claude-sonnet-4",
    ttft_ms: 1000,
    tps: 50,
    latency_ms: 5000,
    inputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheReadTokens: 300,
    cacheWriteTokens: 50,
    cost: 0.01,
    ...overrides,
  }
}

describe("emptyTotals", () => {
  test("starts every counter at zero", () => {
    expect(emptyTotals()).toEqual({
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
    })
  })

  test("returns a fresh object each call (no shared state)", () => {
    const a = emptyTotals()
    const b = emptyTotals()
    a.count = 5
    expect(b.count).toBe(0)
  })
})

describe("accumulate", () => {
  test("mutates the totals in place and counts the entry", () => {
    const totals = emptyTotals()
    accumulate(totals, entry())
    expect(totals).toEqual({
      count: 1,
      ttftSum: 1000,
      tpsSum: 50,
      latencySum: 5000,
      input: 100,
      output: 200,
      reasoning: 0,
      read: 300,
      write: 50,
      cost: 0.01,
    })
  })

  test("sums the counters across entries", () => {
    const totals = emptyTotals()
    accumulate(totals, entry({ inputTokens: 100, outputTokens: 200, cost: 0.01 }))
    accumulate(totals, entry({ inputTokens: 400, outputTokens: 100, cost: 0.02 }))
    expect(totals.count).toBe(2)
    expect(totals.input).toBe(500)
    expect(totals.output).toBe(300)
    expect(totals.cost).toBeCloseTo(0.03, 10)
  })

  test("null TTFT/TPS/latency contribute 0 (deliberate sidebar parity, not a bug fix)", () => {
    const totals = emptyTotals()
    accumulate(totals, entry({ ttft_ms: 1000, tps: 40, latency_ms: 4000 }))
    accumulate(totals, entry({ ttft_ms: null, tps: null, latency_ms: null }))
    // Two entries, one of them null: the null is averaged as 0, so the mean is
    // halved rather than being the single non-null value. Pinned on purpose.
    expect(avgTTFT(totals)).toBe(500)
    expect(avgTPS(totals)).toBe(20)
    expect(avgLatency(totals)).toBe(2000)
  })
})

describe("aggregateBy", () => {
  test("groups by the key function and sums each group", () => {
    const groups = aggregateBy(
      [
        entry({ agent: "build", inputTokens: 100, cost: 0.01 }),
        entry({ agent: "plan", inputTokens: 400, cost: 0.02 }),
        entry({ agent: "build", inputTokens: 50, cost: 0.03 }),
      ],
      (e) => e.agent
    )
    expect([...groups.keys()]).toEqual(["build", "plan"])
    expect(groups.get("build")!.count).toBe(2)
    expect(groups.get("build")!.input).toBe(150)
    expect(groups.get("plan")!.count).toBe(1)
    expect(groups.get("plan")!.input).toBe(400)
  })

  test("empty input returns an empty Map", () => {
    const groups = aggregateBy([], (e) => e.agent)
    expect(groups.size).toBe(0)
  })

  test("does not mutate the input entries", () => {
    const entries = [entry({ inputTokens: 100 })]
    const snapshot = structuredClone(entries)
    aggregateBy(entries, (e) => e.agent)
    expect(entries).toEqual(snapshot)
  })
})

describe("avg helpers", () => {
  test("return null for an empty group", () => {
    const totals = emptyTotals()
    expect(avgTTFT(totals)).toBeNull()
    expect(avgTPS(totals)).toBeNull()
    expect(avgLatency(totals)).toBeNull()
  })

  test("return sum / count otherwise", () => {
    const totals = emptyTotals()
    accumulate(totals, entry({ ttft_ms: 2000, tps: 100, latency_ms: 8000 }))
    accumulate(totals, entry({ ttft_ms: 4000, tps: 200, latency_ms: 12000 }))
    expect(avgTTFT(totals)).toBe(3000)
    expect(avgTPS(totals)).toBe(150)
    expect(avgLatency(totals)).toBe(10000)
  })
})

describe("hitRateOf", () => {
  test("sums counters first, then divides once (not an average of ratios)", () => {
    // Per-entry rates are 10% and 90%; their mean would be 50%. The summed
    // rate is 910 / (910 + 190) = 82.7%, which is what must win.
    const groups = aggregateBy(
      [
        entry({ cacheReadTokens: 10, inputTokens: 90, cacheWriteTokens: 0 }),
        entry({ cacheReadTokens: 900, inputTokens: 100, cacheWriteTokens: 0 }),
      ],
      (e) => e.agent
    )
    const totals = groups.get("build")!
    expect(hitRateOf(totals)).toBeCloseTo(910 / 1100, 10)
    expect(hitRateOf(totals)).not.toBeCloseTo(0.5, 5)
  })

  test("counts a cache write as a miss", () => {
    const totals = emptyTotals()
    accumulate(totals, entry({ cacheReadTokens: 100, inputTokens: 0, cacheWriteTokens: 900 }))
    expect(hitRateOf(totals)).toBeCloseTo(0.1, 10)
  })

  test("no prompt tokens in the group returns null", () => {
    const totals = emptyTotals()
    accumulate(totals, entry({ cacheReadTokens: 0, inputTokens: 0, cacheWriteTokens: 0 }))
    expect(hitRateOf(totals)).toBeNull()
  })
})
