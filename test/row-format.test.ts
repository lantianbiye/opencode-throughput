import { describe, test, expect } from "bun:test"
import {
  formatModelRow,
  formatAgentRow,
  displayWidth,
  modelDisplayName,
  tpsTone,
  type RowLines,
} from "../src/row-format.js"
import type { GroupTotals } from "../src/group-stats.js"

function totals(overrides: Partial<GroupTotals> = {}): GroupTotals {
  return {
    count: 0, ttftSum: 0, tpsSum: 0, latencySum: 0,
    input: 0, output: 0, reasoning: 0,
    read: 0, write: 0, cost: 0,
    ...overrides,
  }
}

const MODEL_KEY = "anthropic/claude-sonnet-4-20250514"

const exact = totals({
  count: 2, ttftSum: 6800, tpsSum: 90, latencySum: 8000,
  input: 12, output: 3, reasoning: 0,
  read: 60, write: 0, cost: 0.01,
})

const sameMs = totals({
  count: 3, ttftSum: 10200, tpsSum: 135, latencySum: 10200,
  input: 20000, output: 8200, reasoning: 1200,
  read: 100000, write: 0, cost: 0.0421,
})

const compact = totals({
  count: 1, ttftSum: 3400, tpsSum: 45, latencySum: 4000,
  input: 12, output: 3, reasoning: 120,
  read: 60, write: 0, cost: 0.01,
})

const noReason = totals({
  count: 2, ttftSum: 4000, tpsSum: 90, latencySum: 8000,
  input: 12000, output: 5000, reasoning: 0,
  read: 50000, write: 0, cost: 0.0105,
})

const bigTokens = totals({
  count: 2, ttftSum: 9000, tpsSum: 100, latencySum: 9000,
  input: 1234567, output: 9876543, reasoning: 0,
  read: 0, write: 1234567, cost: 1234.5678,
})

const dropSet = totals({
  count: 4, ttftSum: 13600, tpsSum: 180, latencySum: 16000,
  input: 20000, output: 8200, reasoning: 1200,
  read: 100000, write: 0, cost: 0.0421,
})

const deepseek = totals({
  count: 1, tpsSum: 95, latencySum: 250, ttftSum: 120,
  input: 21300, output: 260, reasoning: 49,
  read: 0, write: 0, cost: 0.0034,
})

const REPRESENTATIVE: GroupTotals[] = [sameMs, noReason, exact, totals(), bigTokens]

// Caller-supplied row prefixes, mirroring the TUI's collapse markers.
const PREFIX = "  \u2502\u25bc " // "  │▼ "
const COLLAPSED_PREFIX = "  \u2502\u25b6 " // "  │▶ "

/** Flatten a formatted row into its plain text lines (line 2 omitted when null). */
function lineTexts(r: RowLines): string[] {
  const lines = [r.line1.map((s) => s.text).join("")]
  if (r.line2 !== null) lines.push(r.line2)
  return lines
}

function allRows(t: GroupTotals, width: number): RowLines[] {
  return [
    formatModelRow(PREFIX, MODEL_KEY, t, width),
    formatModelRow(PREFIX, "openai/gpt-5", t, width),
    formatAgentRow(PREFIX, "orchestrator", 2, t, width),
    formatAgentRow(COLLAPSED_PREFIX, "build", 7, t, width),
    formatAgentRow(PREFIX, "plan", 1, t, width),
  ]
}

// ---------------------------------------------------------------------------
// displayWidth
// ---------------------------------------------------------------------------

describe("displayWidth", () => {
  test("ASCII is single-width", () => {
    expect(displayWidth("hello")).toBe(5)
    expect(displayWidth("")).toBe(0)
  })

  test("↑ and ↓ are counted as double-width", () => {
    expect(displayWidth("\u2191")).toBe(2)
    expect(displayWidth("\u2193")).toBe(2)
    expect(displayWidth("a\u2191b")).toBe(4)
  })

  test("CJK fullwidth characters are double-width", () => {
    expect(displayWidth("\u4E16")).toBe(2)
    expect(displayWidth("\u3042")).toBe(2)
    expect(displayWidth("\uAC00")).toBe(2)
    expect(displayWidth("\uFF21")).toBe(2)
    expect(displayWidth("abc\u4E16def")).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// modelDisplayName
// ---------------------------------------------------------------------------

// Mirror of the production override table. Every entry must map to exactly this
// display string and occupy exactly 10 padded display columns.
const OVERRIDE_CASES: Record<string, string> = {
  "gpt-5.6-luna": "gptl-5.6",
  "glm-5.3-flash": "glmf-5.3",
  "kimi-k2.7-code": "kimic-k2.7",
  "longcat-2.0": "lc-2.0",
  "deepseek-v4.1-flash": "dsf-v4.1",
  "deepseek-v4-pro": "dsp-v4",
  "deepseek-v4-flash": "dsf-v4",
  "deepseek-flash": "dsf",
  "deepseek-v4-flash-vision-exp": "dsfve-v4",
  "mimo-v2.5-pro": "mmp-v2.5",
  "mimo-v2-pro": "mmp-v2",
  "mimo-v2-omni": "mmo-v2",
  "minimax-m2.7": "mmx-m2.7",
  "minimax-m2.5": "mmx-m2.5",
  "muse-spark-1.3-contributor": "msp-1.3",
  "muse-spark-1.2-contributor": "msp-1.2",
  "qwen3.8-max": "qwm-3.8",
  "qwen3.8-flash": "qwf-3.8",
  "qwen3.7-max": "qwm-3.7",
  "qwen3.7-plus": "qwpl-3.7",
  "qwen3.6-plus": "qwpl-3.6",
  "qwen3.5-plus": "qwpl-3.5",
  "hy4-preview": "hypv-4",
  "hy3-preview": "hypv-3",
  "union-alpha": "union-a",
  "ox-alpha-free": "ox-a",
}

// Ids that must pass through unchanged (they are already <= 10 columns).
const PASS_THROUGH_CASES = [
  "grok-4.6", "grok-4.5",
  "glm-5.3", "glm-5.2", "glm-5.1", "glm-5",
  "kimi-k3", "kimi-k2.6", "kimi-k2.5",
  "mimo-v2.5", "minimax-m3",
  "hy3", "omen-alpha",
]

describe("modelDisplayName", () => {
  test("every override maps to its exact expected display string", () => {
    for (const [raw, expected] of Object.entries(OVERRIDE_CASES)) {
      expect(modelDisplayName(raw).trimEnd()).toBe(expected)
    }
  })

  test("every override result is <= 10 display columns (padded to 10)", () => {
    for (const raw of Object.keys(OVERRIDE_CASES)) {
      expect(displayWidth(modelDisplayName(raw))).toBe(10)
    }
  })

  test("provider prefixes use the last path segment", () => {
    expect(modelDisplayName("opencode-go/deepseek-v4.1-flash").trimEnd()).toBe("dsf-v4.1")
    expect(modelDisplayName("opencode/glm-5.3-flash").trimEnd()).toBe("glmf-5.3")
  })

  test("a short name pads to exactly 10 columns", () => {
    const out = modelDisplayName("grok-4.5")
    expect(out.trimEnd()).toBe("grok-4.5")
    expect(displayWidth(out)).toBe(10)
  })

  test("pass-through ids stay unchanged", () => {
    for (const id of PASS_THROUGH_CASES) {
      const out = modelDisplayName(id)
      expect(out.trimEnd()).toBe(id)
      expect(displayWidth(out)).toBe(10)
    }
  })

  test("long unknown ids fall back to a non-empty <= 10 column name", () => {
    for (const id of ["somebrand-9.9-turbo-ultra", "another-very-long-unknown-model-3.0"]) {
      const out = modelDisplayName(id)
      expect(out.length).toBeGreaterThan(0)
      expect(displayWidth(out)).toBe(10)
    }
  })

  test("a bare id with no slash works", () => {
    expect(displayWidth(modelDisplayName("somebrand-9.9-turbo-ultra"))).toBe(10)
    expect(modelDisplayName("deepseek-v4.1-flash").trimEnd()).toBe("dsf-v4.1")
  })

  test("model rows fit at 24/28/34/37/44/60 for varied ids", () => {
    const ids = [
      "mimo-v2.5",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "minimax-m2.7",
      "qwen3.7-plus",
      "hy3",
      "somebrand-9.9-turbo-ultra",
    ]
    for (const w of [24, 28, 34, 37, 44, 60]) {
      for (const id of ids) {
        for (const t of REPRESENTATIVE) {
          for (const line of lineTexts(formatModelRow(PREFIX, id, t, w))) {
            expect(displayWidth(line)).toBeLessThanOrEqual(w)
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// tpsTone
// ---------------------------------------------------------------------------

describe("tpsTone", () => {
  test("thresholds: >=80 good, >=30 fair, <30 poor", () => {
    expect(tpsTone(120)).toBe("good")
    expect(tpsTone(80)).toBe("good")
    expect(tpsTone(79.9)).toBe("fair")
    expect(tpsTone(30)).toBe("fair")
    expect(tpsTone(29.9)).toBe("poor")
    expect(tpsTone(0)).toBe("poor")
  })

  test("null / non-finite -> none (muted)", () => {
    expect(tpsTone(null)).toBe("none")
    expect(tpsTone(Infinity)).toBe("none")
    expect(tpsTone(NaN)).toBe("none")
  })
})

// ---------------------------------------------------------------------------
// Return shape: RowLines with a segmented line 1 and optional line 2
// ---------------------------------------------------------------------------

describe("return shape", () => {
  test("formatModelRow returns RowLines with segments", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    expect(Array.isArray(r.line1)).toBe(true)
    for (const seg of r.line1) expect(typeof seg.text).toBe("string")
    expect(r.line2 === null || typeof r.line2 === "string").toBe(true)
  })

  test("formatAgentRow returns RowLines with segments", () => {
    const r = formatAgentRow(PREFIX, "orchestrator", 2, sameMs, 44)
    expect(Array.isArray(r.line1)).toBe(true)
    for (const seg of r.line1) expect(typeof seg.text).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// Speed segment carries the tone; every other segment stays muted
// ---------------------------------------------------------------------------

describe("speed segment tone", () => {
  test("only the speed segment carries a tps tone", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    const tps = r.line1.filter((s) => s.tps !== undefined)
    expect(tps.length).toBe(1)
    expect(tps[0].text).toBe("45tk/s")
    expect(tps[0].tps).toBe("fair")
  })

  test("fast speed is good, slow speed is poor", () => {
    const fast = formatModelRow(PREFIX, "x/m", totals({ count: 1, tpsSum: 120, cost: 0.01 }), 44)
    const slow = formatModelRow(PREFIX, "x/m", totals({ count: 1, tpsSum: 12, cost: 0.01 }), 44)
    expect(fast.line1.find((s) => s.tps)?.tps).toBe("good")
    expect(slow.line1.find((s) => s.tps)?.tps).toBe("poor")
  })

  test("a zero average speed is poor (red), not missing", () => {
    const r = formatModelRow(PREFIX, "x/m", totals({ count: 1, tpsSum: 0, cost: 0.01 }), 44)
    const tps = r.line1.find((s) => s.tps !== undefined)
    expect(tps?.text).toBe("0tk/s")
    expect(tps?.tps).toBe("poor")
  })
})

// ---------------------------------------------------------------------------
// Width guarantee: every line fits
// ---------------------------------------------------------------------------

describe("width guarantee", () => {
  test("every line fits display-width 12..120 for every representative totals", () => {
    const violations: string[] = []
    for (let width = 12; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          for (const line of lineTexts(row)) {
            const dw = displayWidth(line)
            if (dw > width) {
              violations.push(`w=${width} dw=${dw} |${line}|`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("widths below 12 hard-truncate instead of overflowing", () => {
    const violations: string[] = []
    for (let width = 0; width < 12; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          for (const line of lineTexts(row)) {
            if (line.length > width) {
              violations.push(`w=${width} len=${line.length} |${line}|`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no row exceeds 2 lines", () => {
    const violations: string[] = []
    for (let width = 12; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          if (lineTexts(row).length > 2) {
            violations.push(`w=${width} ${lineTexts(row).length} lines`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// No lone ↓ without ↑
// ---------------------------------------------------------------------------

describe("token field grouping", () => {
  test("lone ↓ without ↑ is never produced", () => {
    const violations: string[] = []
    for (let width = 12; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          for (const line of lineTexts(row)) {
            const hasDown = line.includes("\u2193") && !line.includes("\u2193r")
            const hasUp = line.includes("\u2191")
            if (hasDown && !hasUp) {
              violations.push(`w=${width} lone ↓ in |${line}|`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("↓r without ↓ never appears", () => {
    const violations: string[] = []
    for (let width = 12; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          for (const line of lineTexts(row)) {
            const hasReason = line.includes("\u2193r")
            const hasDown = line.includes("\u2193")
            if (hasReason && !hasDown) {
              violations.push(`w=${width} ↓r without ↓ in |${line}|`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Truncation uses … not .
// ---------------------------------------------------------------------------

describe("truncation", () => {
  test("clamped model rows end with … (U+2026), not dot", () => {
    // At very narrow widths the whole line is clipped by clampRow — the
    // ellipsis must still be U+2026.
    const row = formatModelRow(PREFIX, MODEL_KEY, exact, 14)
    const joined = lineTexts(row).join(" ")
    expect(joined).toContain("\u2026")
    expect(joined).not.toMatch(/\w\.\s/)
  })
})

// ---------------------------------------------------------------------------
// Two-line behavior
// ---------------------------------------------------------------------------

describe("two-line behavior", () => {
  test("expanded model rows always carry a detail line", () => {
    for (const w of [24, 28, 34, 37, 44, 60, 120]) {
      const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, w)
      expect(r.line2).not.toBeNull()
      expect(r.line2!.startsWith("  \u2502   ")).toBe(true)
    }
  })

  test("model request count starts line 2 with an r suffix", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    expect(r.line2!).toContain("\u2502   3r ")
  })

  test("agent request count stays on line 1 with an r suffix", () => {
    const r = formatAgentRow(PREFIX, "orchestrator", 3, sameMs, 44)
    expect(lineTexts(r)[0]).toContain("orchestrator 3r")
    expect(r.line2).not.toContain("3r")
  })

  test("agent line 2 carries tokens and hit rate", () => {
    const r = formatAgentRow(PREFIX, "orchestrator", 1, deepseek, 44)
    expect(r.line2).toContain("\u219121.3k")
    expect(r.line2).toContain("0%")
  })
})

// ---------------------------------------------------------------------------
// Continuation prefix
// ---------------------------------------------------------------------------

describe("continuation line prefix", () => {
  test("line 2 starts with '  │   ' (bar + 3 spaces)", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    expect(r.line2!.startsWith("  \u2502   ")).toBe(true)
  })

  test("line 1 uses the caller-supplied prefix", () => {
    const expanded = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    const collapsed = formatModelRow(COLLAPSED_PREFIX, MODEL_KEY, sameMs, 44)
    expect(lineTexts(expanded)[0].startsWith("  \u2502\u25bc ")).toBe(true)
    expect(lineTexts(collapsed)[0].startsWith("  \u2502\u25b6 ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Exact strings at key widths
// ---------------------------------------------------------------------------

describe("exact strings", () => {
  test("model row at 44 cols", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 44)
    expect(lineTexts(r)[0]).toBe("  \u2502\u25bc claude-4   3.4s 45tk/s 3.4s $0.0421")
    expect(r.line2).toBe("  \u2502   3r \u219120.0k \u21938.2k \u2193r1.2k 83%")
  })

  test("model row at 37 cols drops latency, count on line 2", () => {
    const r = formatModelRow(PREFIX, "opencode-go/deepseek-v4.1-flash", deepseek, 37)
    expect(lineTexts(r)[0]).toBe("  \u2502\u25bc dsf-v4.1   120ms 95tk/s $0.0034")
    expect(r.line2).toBe("  \u2502   1r \u219121.3k \u2193260 \u2193r49 0%")
  })

  test("agent names are padded to a fixed column", () => {
    const a = formatAgentRow(PREFIX, "orchestrator", 3, sameMs, 44)
    const b = formatAgentRow(PREFIX, "explorer", 1, sameMs, 44)
    expect(lineTexts(a)[0]).toBe("  \u2502\u25bc orchestrator 3r 45tk/s $0.0421")
    expect(lineTexts(b)[0]).toBe("  \u2502\u25bc explorer     1r 45tk/s $0.0421")
    expect(b.line2).toBe("  \u2502   \u219120.0k \u21938.2k \u2193r1.2k 83%")
  })
})

// ---------------------------------------------------------------------------
// Minimal tier (width < 24)
// ---------------------------------------------------------------------------

describe("minimal tier", () => {
  test("model row is a single line with 2-space indent and no line 2", () => {
    const r = formatModelRow(PREFIX, MODEL_KEY, sameMs, 20)
    expect(r.line2).toBeNull()
    const line = lineTexts(r)[0]
    expect(line.startsWith("  ")).toBe(true)
    expect(line.startsWith("  \u2502")).toBe(false)
    expect(displayWidth(line)).toBeLessThanOrEqual(20)
  })

  test("agent row is a single line and keeps the colored speed", () => {
    const r = formatAgentRow(PREFIX, "orchestrator", 2, sameMs, 20)
    expect(r.line2).toBeNull()
    expect(r.line1.some((s) => s.tps !== undefined)).toBe(true)
    expect(displayWidth(lineTexts(r)[0])).toBeLessThanOrEqual(20)
  })
})

// ---------------------------------------------------------------------------
// Cost never truncated mid-token
// ---------------------------------------------------------------------------

describe("cost integrity", () => {
  test("cost is never chopped at narrow widths", () => {
    for (let width = 24; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        const rows = [
          formatModelRow(PREFIX, MODEL_KEY, t, width),
          formatAgentRow(PREFIX, "orchestrator", 4, t, width),
        ]
        for (const r of rows) {
          for (const line of lineTexts(r)) {
            if (line.includes("$")) {
              expect(line).not.toMatch(/\$\d+\.\d{1,3}$/)
            }
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Zero-token rows
// ---------------------------------------------------------------------------

describe("zero-token rows", () => {
  // A row where all token counts are zero (errored request or empty generation).
  const zeroTokens = totals({
    count: 1, tpsSum: 41, ttftSum: 900, latencySum: 2100,
    input: 0, output: 0, reasoning: 0,
    read: 0, write: 0, cost: 0.0004,
  })

  const ZERO_WIDTHS = [24, 28, 34, 44, 60, 80]

  test("zero-token model row still shows the request count on line 2", () => {
    for (const w of ZERO_WIDTHS) {
      const r = formatModelRow(PREFIX, MODEL_KEY, zeroTokens, w)
      for (const line of lineTexts(r)) {
        expect(displayWidth(line)).toBeLessThanOrEqual(w)
      }
      expect(r.line2!).toContain("\u2502   1r")
      // No token arrows and no "N/A" hit rate in a zero-token row.
      expect(r.line2).not.toContain("\u2191")
      expect(r.line2).not.toContain("N/A")
    }
  })

  test("zero-token agent row emits no detail line", () => {
    for (const w of ZERO_WIDTHS) {
      const r = formatAgentRow(PREFIX, "orchestrator", 1, zeroTokens, w)
      expect(r.line2).toBeNull()
      for (const line of lineTexts(r)) {
        expect(displayWidth(line)).toBeLessThanOrEqual(w)
      }
    }
  })
})
