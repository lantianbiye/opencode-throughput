// Pure, width-aware row formatters for the throughput TUI sidebar.
//
// The older in-component implementations dropped fields with
// `row.replace(" " + latStr, "")`. TTFT and latency both flow through
// `formatMs`, so when they formatted to the same string the replacement removed
// the *first* occurrence -- the TTFT -- not the latency it claimed to drop. The
// visible text happened to be identical, but the logic was wrong. Here every
// row is an ordered array of fields and drops remove a field by identity, never
// by string matching.
//
// The three functions take the true pane width and subtract their own indent:
// model and child own their 2/4-space indent, agent owns the caller-supplied
// 4-character prefix. The caller must NOT pre-subtract the prefix (doing so
// would budget the agent row `pane - 8`). Every return value is guaranteed to be
// at most `width` columns wide for any width >= 12.
//
// Narrow-pane policy: a field is dropped whole, never truncated mid-token. A
// clipped number such as "$0.0." or "8." reads as a real (wrong) value, whereas
// an absent field plus a shorter label is honest. The hit rate and cost are the
// point of the feature, so they are never droppable; the ordered drop list alone
// drives degradation, so the compact `{name} {hr}% ${cost}` form is simply the
// natural end of the chain (all droppable fields gone, name squeezed last).
// There is nothing left to shrink in the numbers themselves -- `formatTokenCount`
// already emits at most "12.0k" -- so only the label and the field set move.

import { formatHitPercent, formatTokenCount } from "./cache-rate.js"
import {
  avgLatency,
  avgTPS,
  avgTTFT,
  hitRateOf,
  type GroupTotals,
} from "./group-stats.js"

// --- local copies of the small TUI formatters ------------------------------
// Deliberately duplicated: the other lane keeps its own copies in src/tui.tsx
// for now, and importing from a .tsx component would drag JSX/runtime concerns
// into this pure module.

function formatNum(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "N/A"
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return n.toFixed(n >= 100 ? 0 : 1)
}

function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "N/A"
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m"
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s"
  return ms.toFixed(0) + "ms"
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "." : s
}

// --- row assembly helpers --------------------------------------------------

interface Field {
  id: string
  text: string
}

const MODEL_DROP_ORDER = ["lat", "count", "ttft", "tps"] as const
const AGENT_DROP_ORDER = ["reason", "count", "out", "in"] as const
const CHILD_DROP_ORDER = ["reason", "out", "in"] as const

/** Name followed by space-separated fields; no indent. */
function assemble(name: string, fields: readonly string[]): string {
  return fields.length === 0 ? name : name + " " + fields.join(" ")
}

/** Spaces consumed by the single separator before each field. */
function fixedWidth(fields: readonly Field[]): number {
  return fields.length === 0
    ? 0
    : fields.reduce((sum, f) => sum + f.text.length, 0) + fields.length
}

/**
 * Hard truncation that never slices with a negative index and never returns a
 * string longer than `width`. When it truncates it keeps the length exactly
 * `width` by ending on the same trailing-"." convention as `trunc`.
 */
function clampRow(s: string, width: number): string {
  const n = Math.floor(width)
  if (!(n > 0)) return ""
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "."
}

/** Minimum columns reserved for the name before a field is dropped instead. */
const MIN_NAME = 8

/**
 * Shared assembly: keep as many fields as possible while giving the name the
 * remaining budget. Drops happen by field identity in `droppable` order; when
 * nothing droppable is left the name is truncated at MIN_NAME and the whole row
 * is clamped, so the width guarantee always holds.
 */
function layoutRow(
  indent: string,
  name: string,
  fields: Field[],
  droppable: readonly string[],
  width: number
): string {
  let present = fields
  for (;;) {
    const budget = width - indent.length - fixedWidth(present)
    if (budget >= MIN_NAME || name.length <= budget) {
      const shown = name.length <= budget ? name : trunc(name, budget)
      return clampRow(indent + assemble(shown, present.map((f) => f.text)), width)
    }
    const drop = droppable.find((id) => present.some((f) => f.id === id))
    if (drop === undefined) {
      // No field left to trade away. Give the name whatever remains (even below
      // MIN_NAME) rather than overflow: numeric fields must never be chopped,
      // and the compact form is defined to keep in/out/hr/cost. The final clamp
      // only bites when even the fields alone exceed the width.
      const shown = name.length <= budget ? name : trunc(name, Math.max(budget, 1))
      return clampRow(indent + assemble(shown, present.map((f) => f.text)), width)
    }
    present = present.filter((f) => f.id !== drop)
  }
}

function modelFields(t: GroupTotals): Field[] {
  const fields: Field[] = [
    { id: "ttft", text: formatMs(avgTTFT(t)) },
    { id: "tps", text: formatNum(avgTPS(t)) + "/s" },
    { id: "count", text: String(t.count) },
    { id: "lat", text: formatMs(avgLatency(t)) },
    { id: "in", text: "\u2191" + formatTokenCount(t.input) },
    { id: "out", text: "\u2193" + formatTokenCount(t.output) },
    { id: "reason", text: "\u2193r" + formatTokenCount(t.reasoning) },
  ]
  fields.push({ id: "hr", text: formatHitPercent(hitRateOf(t)) })
  fields.push({ id: "cost", text: "$" + t.cost.toFixed(4) })
  return fields
}

// --- model row -------------------------------------------------------------

/**
 * `{name} {ttft} {tps}/s {count} {lat} ↑{in} ↓{out} ↓r{r} {hr} ${cost}`
 * Owns a 2-space indent. Drop priority: lat → count → ttft → tps. Reasoning
 * is always shown.
 */
export function formatModelRow(modelKey: string, t: GroupTotals, width: number): string {
  const name = modelKey.split("/").pop() ?? modelKey
  const indent = "  "
  return layoutRow(indent, name, modelFields(t), MODEL_DROP_ORDER, width)
}

// --- agent row -------------------------------------------------------------

function agentFields(count: number, t: GroupTotals): Field[] {
  const fields: Field[] = [
    { id: "count", text: String(count) },
    { id: "in", text: "\u2191" + formatTokenCount(t.input) },
    { id: "out", text: "\u2193" + formatTokenCount(t.output) },
  ]
  if (t.reasoning > 0) {
    fields.push({ id: "reason", text: "\u2193r" + formatTokenCount(t.reasoning) })
  }
  fields.push({ id: "hr", text: formatHitPercent(hitRateOf(t)) })
  fields.push({ id: "cost", text: "$" + t.cost.toFixed(4) })
  return fields
}

/**
 * `{agent} {count} \u2191{in} \u2193{out} [\u2193r{r}] {hr} ${cost}`
 * The caller supplies the 4-character prefix, so no indent is added here.
 * Drop priority: \u2193r \u2192 count \u2192 \u2193out \u2192 \u2191in.
 */
export function formatAgentRow(
  prefix: string,
  agentName: string,
  count: number,
  t: GroupTotals,
  width: number
): string {
  const name = trunc(agentName, 10)
  return layoutRow(prefix, name, agentFields(count, t), AGENT_DROP_ORDER, width)
}

// --- child session row -----------------------------------------------------

function childFields(t: GroupTotals): Field[] {
  const fields: Field[] = [
    { id: "in", text: "\u2191" + formatTokenCount(t.input) },
    { id: "out", text: "\u2193" + formatTokenCount(t.output) },
  ]
  if (t.reasoning > 0) {
    fields.push({ id: "reason", text: "\u2193r" + formatTokenCount(t.reasoning) })
  }
  fields.push({ id: "hr", text: formatHitPercent(hitRateOf(t)) })
  fields.push({ id: "cost", text: "$" + t.cost.toFixed(4) })
  return fields
}

/**
 * `{label} \u2191{in} \u2193{out} [\u2193r{r}] {hr} ${cost}`
 * Owns a 4-space indent; the current session is marked with a leading "*".
 * Drop priority: \u2193r \u2192 \u2193out \u2192 \u2191in.
 */
export function formatChildRow(
  label: string,
  t: GroupTotals,
  isCurrent: boolean,
  width: number
): string {
  // The "*" marker for the current session eats one char of the label budget.
  const name = isCurrent ? "*" + trunc(label, 13) : trunc(label, 14)
  const indent = "    "
  return layoutRow(indent, name, childFields(t), CHILD_DROP_ORDER, width)
}
