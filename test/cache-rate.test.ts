import { describe, test, expect } from "bun:test"
import {
  cacheHitRate,
  formatCacheLine,
  formatTokenCount,
  promptTokensTotal,
} from "../src/cache-rate.js"

describe("cacheHitRate", () => {
  test("returns null when no prompt tokens have been observed", () => {
    expect(cacheHitRate({ read: 0, input: 0, write: 0 })).toBeNull()
    expect(formatCacheLine({ read: 0, input: 0, write: 0 })).toBeNull()
  })

  test("treats a cache write as a miss: read / (read + input + write)", () => {
    // read/(read+input) would be 100% here; the chosen formula must give 10%.
    expect(cacheHitRate({ read: 100, input: 0, write: 900 })).toBeCloseTo(0.1, 10)
    expect(formatCacheLine({ read: 100, input: 0, write: 900 })).toBe(
      "  Cache 10.0% 100/1.0k"
    )
  })

  test("is 100% when everything came from the cache", () => {
    expect(cacheHitRate({ read: 1000, input: 0, write: 0 })).toBe(1)
    expect(formatCacheLine({ read: 1000, input: 0, write: 0 })).toBe(
      "  Cache 100.0% 1.0k/1.0k"
    )
  })

  test("is 0% when nothing came from the cache", () => {
    expect(formatCacheLine({ read: 0, input: 1500, write: 500 })).toBe(
      "  Cache 0.0% 0/2.0k"
    )
  })

  test("input is the non-cached share, so cacheRead may exceed input", () => {
    // opencode derives tokens.input as `inputTokens - cacheRead - cacheWrite`
    // (Session.getUsage), i.e. the buckets are disjoint and the denominator here
    // is the real prompt total. Values below are one real opencode-go request.
    const tokens = { read: 20096, input: 153, write: 0 }
    expect(promptTokensTotal(tokens)).toBe(20249)
    expect(cacheHitRate(tokens)).toBeCloseTo(20096 / 20249, 10)
    expect(formatCacheLine(tokens)).toBe("  Cache 99.2% 20.1k/20.2k")
  })

  test("percentages are on the 0..100 scale", () => {
    const tokens = { read: 12345, input: 2000, write: 500 }
    expect(promptTokensTotal(tokens)).toBe(14845)
    expect(cacheHitRate(tokens)).toBeCloseTo(12345 / 14845, 10)
    // Would render as "0.8%" if the 0..1 fraction were formatted directly.
    expect(formatCacheLine(tokens)).toBe("  Cache 83.2% 12.3k/14.8k")
  })

  test("stays cumulative across the turns of one conversation", () => {
    const turns = [
      { read: 0, input: 2000, write: 2000 },
      { read: 2000, input: 500, write: 0 },
      { read: 2500, input: 100, write: 0 },
    ]
    const total = turns.reduce(
      (acc, t) => ({
        read: acc.read + t.read,
        input: acc.input + t.input,
        write: acc.write + t.write,
      }),
      { read: 0, input: 0, write: 0 }
    )
    expect(total).toEqual({ read: 4500, input: 2600, write: 2000 })
    expect(formatCacheLine(total)).toBe("  Cache 49.5% 4.5k/9.1k")
  })

  test("rejects non-finite and negative totals instead of rendering NaN", () => {
    expect(cacheHitRate({ read: NaN, input: 0, write: 0 })).toBeNull()
    expect(cacheHitRate({ read: -1, input: 0, write: 0 })).toBeNull()
  })
})

describe("formatTokenCount", () => {
  test("abbreviates thousands and millions", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(999)).toBe("999")
    expect(formatTokenCount(1000)).toBe("1.0k")
    expect(formatTokenCount(14845)).toBe("14.8k")
    expect(formatTokenCount(2000000)).toBe("2.00M")
  })
})
