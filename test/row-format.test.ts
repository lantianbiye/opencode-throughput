import { describe, test, expect } from "bun:test"
import { formatModelRow, formatAgentRow, formatChildRow } from "../src/row-format.js"
import type { GroupTotals } from "../src/group-stats.js"

function totals(overrides: Partial<GroupTotals> = {}): GroupTotals {
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
    ...overrides,
  }
}

const MODEL_KEY = "anthropic/claude-sonnet-4-20250514"

// avg TTFT 3.4s, avg TPS 45.0/s. Deliberately a set with no reasoning.
const exact = totals({
  count: 2,
  ttftSum: 6800,
  tpsSum: 90,
  latencySum: 8000,
  input: 12,
  output: 3,
  reasoning: 0,
  read: 60,
  write: 0,
  cost: 0.01,
})

// TTFT and latency both render as "3.4s" -- the substring-replacement trap.
const sameMs = totals({
  count: 3,
  ttftSum: 10200,
  tpsSum: 135,
  latencySum: 10200,
  input: 20000,
  output: 8200,
  reasoning: 1200,
  read: 100000,
  write: 0,
  cost: 0.0421,
})

// Same trap, but compact enough that the degraded form still reads well.
const compact = totals({
  count: 1,
  ttftSum: 3400,
  tpsSum: 45,
  latencySum: 4000,
  input: 12,
  output: 3,
  reasoning: 120,
  read: 60,
  write: 0,
  cost: 0.01,
})

const noReason = totals({
  count: 2,
  ttftSum: 4000,
  tpsSum: 90,
  latencySum: 8000,
  input: 12000,
  output: 5000,
  reasoning: 0,
  read: 50000,
  write: 0,
  cost: 0.0105,
})

const bigTokens = totals({
  count: 2,
  ttftSum: 9000,
  tpsSum: 100,
  latencySum: 9000,
  input: 1234567,
  output: 9876543,
  reasoning: 0,
  read: 0,
  write: 1234567,
  cost: 1234.5678,
})

// Agent/child drop-order set: every droppable field is present and the numbers
// are big enough that field drops actually happen at sidebar widths.
const dropSet = totals({
  count: 4,
  ttftSum: 13600,
  tpsSum: 180,
  latencySum: 16000,
  input: 20000,
  output: 8200,
  reasoning: 1200,
  read: 100000,
  write: 0,
  cost: 0.0421,
})

// Small-token set used to pin the gradual-degradation policy: the token fields
// are narrow enough that timing fields survive down to ~33 columns.
const report = totals({
  count: 2,
  ttftSum: 6800,
  tpsSum: 90,
  latencySum: 6800,
  input: 5,
  output: 3,
  reasoning: 120,
  read: 15,
  write: 0,
  cost: 0.01,
})

const REPRESENTATIVE: GroupTotals[] = [
  sameMs,
  noReason,
  exact,
  totals(),
  bigTokens,
]

function allRows(t: GroupTotals, width: number): string[] {
  return [
    formatModelRow(MODEL_KEY, t, width),
    formatModelRow("openai/gpt-5", t, width),
    formatAgentRow("  \u25bc ", "orchestrator", 2, t, width),
    formatAgentRow("  \u25b6 ", "build", 7, t, width),
    formatAgentRow("    ", "plan", 1, t, width),
    formatChildRow("session-label-xyz", t, false, width),
    formatChildRow("session-label-xyz", t, true, width),
  ]
}

function countOccurrences(s: string, sub: string): number {
  return s.split(sub).length - 1
}

describe("width guarantee", () => {
  test("every row fits widths 12..120 for every representative totals", () => {
    const violations: string[] = []
    for (let width = 12; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          if (row.length > width) {
            violations.push(`w=${width} len=${row.length} |${row}|`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("widths below 12 hard-truncate instead of overflowing or slicing negatively", () => {
    const violations: string[] = []
    for (let width = 0; width < 12; width++) {
      for (const t of REPRESENTATIVE) {
        for (const row of allRows(t, width)) {
          if (row.length > width) {
            violations.push(`w=${width} len=${row.length} |${row}|`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("agent/child never truncate hr or cost while a droppable field remains", () => {
    const violations: string[] = []
    // 19 is the first width where the biggest representative cost ("$1234.5678")
    // plus a 1-char name fits; below that the final clamp is the only (allowed)
    // chopping case.
    for (let width = 19; width <= 120; width++) {
      for (const t of REPRESENTATIVE) {
        const rows = [
          formatAgentRow("  \u25bc ", "orchestrator", 4, t, width),
          formatAgentRow("  \u25b6 ", "build", 7, t, width),
          formatAgentRow("    ", "plan", 1, t, width),
          formatChildRow("session-label-xyz", t, false, width),
          formatChildRow("session-label-xyz", t, true, width),
        ]
        for (const row of rows) {
          const costIntact = /\$\d+\.\d{4}$/.test(row)
          const hrIntact = row.includes("%") ? /\d+%/.test(row) : row.includes("N/A")
          if (!costIntact || !hrIntact) violations.push(`w=${width} |${row}|`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

describe("formatModelRow", () => {
  test("takes the short model name from the last path segment", () => {
    expect(formatModelRow("openai/gpt-5", exact, 45)).toContain("gpt-5")
    expect(formatModelRow("anthropic/claude-sonnet-4-20250514", exact, 45)).not.toContain("anthropic")
  })

  test("full row carries ttft, tps, count, latency, tokens, hit rate and cost", () => {
    const row = formatModelRow(MODEL_KEY, sameMs, 80)
    expect(row).toBe(
      "  claude-sonnet-4-20250514 3.4s 45.0/s 3 3.4s \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )
  })

  test("drops lat \u2192 count \u2192 ttft \u2192 tps as the width shrinks (reasoning is permanent)", () => {
    // Full row has all fields including count=3 and reason
    const full = formatModelRow(MODEL_KEY, sameMs, 80)
    expect(full).toContain("\u2193r1.2k")
    expect(full).toContain("45.0/s")
    expect(full).toContain(" 3 ")

    // lat gone, everything else still present
    const noLat = formatModelRow(MODEL_KEY, sameMs, 58)
    expect(noLat).toContain("45.0/s")
    expect(noLat).toContain("\u2193r1.2k")
    expect(noLat).toContain("3 ")

    // count gone (lat+count), tps still present
    const noCount = formatModelRow(MODEL_KEY, sameMs, 51)
    expect(noCount).toContain("45.0/s")
    expect(noCount).toContain("\u2193r1.2k")
    expect(noCount).not.toMatch(/ 3 /)

    // ttft gone (lat+count+ttft), tps still present
    const noTtft = formatModelRow(MODEL_KEY, sameMs, 49)
    expect(noTtft).toContain("45.0/s")
    expect(noTtft).not.toContain("3.4s")
    expect(noTtft).toContain("\u2193r1.2k")

    // tps gone (all droppable fields gone)
    const noTps = formatModelRow(MODEL_KEY, sameMs, 48)
    expect(noTps).not.toContain("/s")
    expect(noTps).not.toContain("3.4s")
    expect(noTps).toContain("\u2193r1.2k")
  })

  test("drops latency by field identity, not by substring replacement", () => {
    // ttft and lat both render as "3.4s". The old `row.replace(" 3.4s", "")`
    // removed the FIRST occurrence -- the TTFT -- and left the latency. At w=51
    // lat+count+ttft are all dropped, leaving tps as the first timing field.
    const row = formatModelRow(MODEL_KEY, sameMs, 51)
    expect(row).toBe("  claude-so. 45.0/s \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421")
    expect(row).toContain("45.0/s")
    expect(row).not.toContain("3.4s")
  })

  test("reaches the no-timing end state only after the drop chain is exhausted", () => {
    const row = formatModelRow(MODEL_KEY, compact, 28)
    expect(row).toBe("  . \u219112 \u21933 \u2193r120 83% $0.0100")
    expect(row).toContain("\u2193r120")
    expect(row).not.toContain("/s")
    expect(row).not.toContain("3.4s")
  })

  test("reaches the no-timing compact form at narrow widths", () => {
    const row = formatModelRow(MODEL_KEY, report, 33)
    expect(row).toBe("  claude. \u21915 \u21933 \u2193r120 75% $0.0100")
    expect(row).not.toContain("/s")
    expect(row).not.toContain("3.4s")
  })

  test("a group with no prompt tokens renders N/A, never NaN", () => {
    const row = formatModelRow("openai/gpt-5", totals(), 45)
    expect(row).toContain("N/A")
    expect(row).not.toContain("NaN")
  })

  test("exact strings at 45 / 35 / 28 columns", () => {
    expect(formatModelRow(MODEL_KEY, exact, 45)).toBe(
      "  claude-. 3.4s 45.0/s \u219112 \u21933 \u2193r0 83% $0.0100"
    )
    expect(formatModelRow(MODEL_KEY, exact, 35)).toBe(
      "  claude-so. \u219112 \u21933 \u2193r0 83% $0.0100"
    )
    expect(formatModelRow(MODEL_KEY, exact, 28)).toBe(
      "  cl. \u219112 \u21933 \u2193r0 83% $0.0100"
    )
  })
})

describe("formatAgentRow", () => {
  test("truncates the agent name to 10 characters", () => {
    expect(formatAgentRow("  \u25bc ", "orchestrator", 2, exact, 45)).toBe(
      "  \u25bc orchestra. 2 \u219112 \u21933 83% $0.0100"
    )
  })

  test("keeps all three caller prefixes", () => {
    expect(formatAgentRow("  \u25bc ", "build", 2, exact, 45)).toContain("  \u25bc ")
    expect(formatAgentRow("  \u25b6 ", "build", 2, exact, 45)).toContain("  \u25b6 ")
    expect(formatAgentRow("    ", "build", 2, exact, 45)).toContain("    ")
  })

  test("drops reason \u2192 count \u2192 \u2193out \u2192 \u2191in as the width shrinks", () => {
    const wide = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 60)
    expect(wide).toBe(
      "  \u25bc orchestra. 4 \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )

    // reason gone
    const noReason = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 45)
    expect(noReason).not.toContain("\u2193r")
    expect(noReason).toContain("4")
    expect(noReason).toContain("\u219120.0k")
    expect(noReason).toContain("\u21938.2k")

    // count gone
    const noCount = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 38)
    expect(noCount).not.toContain("\u2193r")
    expect(noCount).not.toMatch(/ 4 /)
    expect(noCount).toContain("\u219120.0k")
    expect(noCount).toContain("\u21938.2k")

    // out gone
    const noOut = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 36)
    expect(noOut).not.toContain("\u21938.2k")
    expect(noOut).toContain("\u219120.0k")

    // in survives at 35 columns -- a gradual drop beats a cliff-edge compact
    const keepsIn = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 35)
    expect(keepsIn).toBe("  \u25bc orchestra. \u219120.0k 83% $0.0421")
    expect(keepsIn).toContain("\u219120.0k")
    expect(keepsIn).not.toContain("\u21938.2k")

    // in drops only when it genuinely cannot fit
    const degenerate = formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 30)
    expect(degenerate).not.toContain("\u2191")
    expect(degenerate).not.toContain("\u2193")

    for (const row of [wide, noReason, noCount, noOut, keepsIn, degenerate]) {
      expect(row).toContain("83%")
      expect(row).toContain("$0.0421")
    }
  })

  test("end state keeps only name, hr and cost once every droppable field is gone", () => {
    // width 35 still holds ↑in; the degenerate form must not appear yet.
    expect(formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 35)).toBe(
      "  \u25bc orchestra. \u219120.0k 83% $0.0421"
    )
    // width 30 cannot hold ↑in alongside hr+cost, so it drops.
    expect(formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, 30)).toBe(
      "  \u25bc orchestra. 83% $0.0421"
    )
  })

  test("exact strings at 45 / 35 / 28 / 24 columns keep hr and cost intact", () => {
    expect(formatAgentRow("  \u25bc ", "orchestrator", 2, exact, 45)).toBe(
      "  \u25bc orchestra. 2 \u219112 \u21933 83% $0.0100"
    )
    expect(formatAgentRow("  \u25bc ", "orchestrator", 2, exact, 35)).toBe(
      "  \u25bc orchestra. 2 \u219112 \u21933 83% $0.0100"
    )
    expect(formatAgentRow("  \u25bc ", "orchestrator", 2, exact, 28)).toBe(
      "  \u25bc orchest. \u219112 83% $0.0100"
    )
    expect(formatAgentRow("  \u25bc ", "orchestrator", 2, exact, 24)).toBe(
      "  \u25bc orchest. 83% $0.0100"
    )
  })

  test("keeps \u2191in at a 35-column pane instead of the degenerate form", () => {
    expect(formatAgentRow("  \u25bc ", "orchestrator", 4, report, 35)).toBe(
      "  \u25bc orchestra. 4 \u21915 \u21933 75% $0.0100"
    )
  })

  test("never chops hr or cost mid-token at narrow widths", () => {
    const rows = [28, 35].flatMap((width) => [
      formatAgentRow("  \u25bc ", "orchestrator", 4, dropSet, width),
      formatAgentRow("  \u25bc ", "orchestrator", 2, exact, width),
    ])
    for (const row of rows) {
      expect(row).not.toMatch(/\$0\.0\.$/)
      expect(row).not.toMatch(/ \d+\.$/)
    }
  })
})

describe("formatChildRow", () => {
  test("marks the current session with a leading * and reserves a char for it", () => {
    const normal = formatChildRow("session-label-xyz", exact, false, 45)
    const current = formatChildRow("session-label-xyz", exact, true, 45)
    expect(normal).toBe("    session-label. \u219112 \u21933 83% $0.0100")
    expect(current).toBe("    *session-labe. \u219112 \u21933 83% $0.0100")
    expect(current).toContain("*")
  })

  test("drops reason \u2192 \u2193out \u2192 \u2191in as the width shrinks", () => {
    const wide = formatChildRow("session-label-xyz", dropSet, false, 60)
    expect(wide).toBe(
      "    session-label. \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )

    const noReason = formatChildRow("session-label-xyz", dropSet, false, 43)
    expect(noReason).not.toContain("\u2193r")
    expect(noReason).toContain("\u219120.0k")
    expect(noReason).toContain("\u21938.2k")

    const noOut = formatChildRow("session-label-xyz", dropSet, false, 36)
    expect(noOut).not.toContain("\u21938.2k")
    expect(noOut).toContain("\u219120.0k")

    // in survives at 35 columns -- only ↓out had to go
    const keepsIn = formatChildRow("session-label-xyz", dropSet, false, 35)
    expect(keepsIn).toBe("    session-lab. \u219120.0k 83% $0.0421")
    expect(keepsIn).toContain("\u219120.0k")
    expect(keepsIn).not.toContain("\u21938.2k")

    // in drops only when it genuinely cannot fit
    const degenerate = formatChildRow("session-label-xyz", dropSet, false, 30)
    expect(degenerate).not.toContain("\u2191")
    expect(degenerate).not.toContain("\u2193")

    for (const row of [wide, noReason, noOut, keepsIn, degenerate]) {
      expect(row).toContain("83%")
      expect(row).toContain("$0.0421")
    }
  })

  test("end state keeps only label, hr and cost once every droppable field is gone", () => {
    expect(formatChildRow("session-label-xyz", dropSet, false, 35)).toBe(
      "    session-lab. \u219120.0k 83% $0.0421"
    )
    expect(formatChildRow("session-label-xyz", dropSet, false, 30)).toBe(
      "    session-label. 83% $0.0421"
    )
  })

  test("exact strings at 45 / 35 / 28 / 24 columns keep hr and cost intact", () => {
    expect(formatChildRow("session-label-xyz", exact, false, 45)).toBe(
      "    session-label. \u219112 \u21933 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, false, 35)).toBe(
      "    session-lab. \u219112 \u21933 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, false, 28)).toBe(
      "    session. \u219112 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, false, 24)).toBe(
      "    session. 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, true, 45)).toBe(
      "    *session-labe. \u219112 \u21933 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, true, 28)).toBe(
      "    *sessio. \u219112 83% $0.0100"
    )
    expect(formatChildRow("session-label-xyz", exact, true, 24)).toBe(
      "    *sessio. 83% $0.0100"
    )
  })

  test("never chops hr or cost mid-token at narrow widths", () => {
    const rows = [28, 35].flatMap((width) => [
      formatChildRow("session-label-xyz", dropSet, false, width),
      formatChildRow("session-label-xyz", dropSet, true, width),
      formatChildRow("session-label-xyz", exact, false, width),
    ])
    for (const row of rows) {
      expect(row).not.toMatch(/\$0\.0\.$/)
      expect(row).not.toMatch(/ \d+\.$/)
    }
  })
})

describe("pane-width contract (no double subtraction)", () => {
  test("agent row is budgeted at the true pane width, not pane - 8", () => {
    // The full row is exactly 48 columns. Passed the 48-column pane width it
    // must come back whole; a formatter that subtracts the prefix a second time
    // would budget 44 and drop ↓r (or clip the cost).
    const row = formatAgentRow("  \u25bc ", "orchestrator", 4, sameMs, 48)
    expect(row).toBe(
      "  \u25bc orchestra. 4 \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )
    expect(row.length).toBe(48)
    expect(row.length).toBeGreaterThan(48 - 4)
    expect(row.endsWith("$0.0421")).toBe(true)
  })

  test("model row is budgeted at the true pane width", () => {
    const row = formatModelRow(MODEL_KEY, sameMs, 75)
    expect(row).toBe(
      "  claude-sonnet-4-20250. 3.4s 45.0/s 3 3.4s \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )
    expect(row.length).toBe(75)
    expect(row.length).toBeGreaterThan(75 - 4)
    expect(row.endsWith("$0.0421")).toBe(true)
  })

  test("child row is budgeted at the true pane width", () => {
    const row = formatChildRow("session-label-xyz", sameMs, false, 50)
    expect(row).toBe(
      "    session-label. \u219120.0k \u21938.2k \u2193r1.2k 83% $0.0421"
    )
    expect(row.length).toBe(50)
    expect(row.length).toBeGreaterThan(50 - 4)
    expect(row.endsWith("$0.0421")).toBe(true)
  })
})
