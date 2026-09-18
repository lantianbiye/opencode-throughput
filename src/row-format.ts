// Pure, width-aware row formatters for the throughput TUI sidebar.
//
// Every format function returns a `RowLines`:
//   line1 - identity + headline numbers (name, TTFT, token speed, latency,
//           cost), returned as colored segments so the token-speed field can
//           carry its own tone while the rest of the row stays muted.
//   line2 - token detail (request count, ↑in ↓out ↓rreason, hit%) as a plain
//           string, or null.
//
// The TUI renders line1 always and line2 only when the row is expanded; the
// collapse state lives in the TUI, not here.  Model rows always produce a
// line2 (the request count lives there) so an expanded model row is always two
// lines.  Agent rows keep the count on line1 and add token detail on line2.
//
// Hierarchy: model and agent rows share the caller-supplied prefix
// ("  │▼ " / "  │▶ "), the section header sits at 2.  The continuation line
// uses "  │   " (6 display cols: the bar + 3 spaces).
//
// Narrow-pane policy: fields are dropped whole, never truncated mid-token.
// Token fields (↑, ↓, ↓r) drop as a group — we never emit a lone ↓ without ↑.
// Hit rate is dropped before the token group (it duplicates the session-wide
// cache line).  Token speed and cost are never droppable.
//
// Minimal tier (width < 24): single line, 2-space indent (no │), name + speed
// + cost only.  Saves vertical space where the continuation line and │ prefix
// would consume too much of the pane; the speed stays colored there too.
//
// Display-width awareness: `displayWidth` and `clampRow` count display columns,
// not JS character length.  East Asian Ambiguous codepoints (↑ U+2191, ↓ U+2193)
// and fullwidth/CJK ranges are counted as double-width so the width guarantee
// holds even for non-Latin session titles.  Box-drawing characters (▾ U+25BE,
// ▶ U+25B6, │ U+2502) are treated as single-width — they are Narrow in most
// terminal fonts.

import { formatHitPercent, formatTokenCount } from "./cache-rate.js"
import {
  avgLatency,
  avgTPS,
  avgTTFT,
  hitRateOf,
  type GroupTotals,
} from "./group-stats.js"

// --- display width ---------------------------------------------------------

// East Asian Ambiguous glyphs that this module emits: ↑ (U+2191), ↓ (U+2193).
// Many terminals (Windows, some Linux) render them as double-width.
const AMBIGUOUS = new Set(["\u2191", "\u2193"])

// Returns 2 for codepoints in known double-width ranges, 1 otherwise.
// This is NOT a full wcwidth — it is a conservative documented subset.
// Over-counting (treating a narrow char as wide) is acceptable: it dims the
// budget slightly early but preserves the never-overflow guarantee.
function wideClass(cp: number): number {
  // CJK Unified Ideographs            U+4E00–U+9FFF
  // CJK Extension A                   U+3400–U+4DBF
  // CJK Compatibility Ideographs      U+F900–U+FAFF
  // Hangul Syllables                  U+AC00–U+D7A3
  // Hiragana                          U+3040–U+309F
  // Katakana                          U+30A0–U+30FF
  // CJK Symbols and Punctuation       U+3000–U+303F
  // Fullwidth Forms                   U+FF00–U+FF60
  // Fullwidth Signs                   U+FFE0–U+FFE6
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2
  }
  return 1
}

/** Display-column width of `s`.  Conservative: treats East Asian Ambiguous
 *  and fullwidth/CJK ranges as double-width so clampRow never underestimates. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    if (AMBIGUOUS.has(ch)) {
      w += 2
    } else {
      w += wideClass(ch.codePointAt(0)!)
    }
  }
  return w
}

// --- row segment model -----------------------------------------------------

/** Color tone for the token-speed field, derived from the average TPS. */
export type TpsTone = "good" | "fair" | "poor" | "none"

/** One colorable run of a row's headline line.  Segments without `tps` are
 *  rendered muted; the `tps` segment is rendered green/yellow/red. */
export interface RowSegment {
  text: string
  tps?: TpsTone
}

/** A formatted row: a headline line of segments plus an optional detail line. */
export interface RowLines {
  line1: RowSegment[]
  line2: string | null
}

/**
 * Token-speed tone thresholds (drives the colored speed field):
 *   good  (green)  >= 80 tk/s
 *   fair  (yellow) >= 30 tk/s
 *   poor  (red)    <  30 tk/s
 *   none  (muted)  speed unavailable
 */
export function tpsTone(tps: number | null): TpsTone {
  if (tps === null || !Number.isFinite(tps)) return "none"
  if (tps >= 80) return "good"
  if (tps >= 30) return "fair"
  return "poor"
}

// --- local copies of the small TUI formatters ------------------------------

function formatTPS(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "N/A"
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return String(Math.round(n))
}

function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "N/A"
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m"
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s"
  return ms.toFixed(0) + "ms"
}

/** Truncate `s` to fit within `max` display columns, appending "…" (U+2026)
 *  when clipping occurs.  Uses display width, not character count. */
function trunc(s: string, max: number): string {
  if (displayWidth(s) <= max) return s
  let w = 0
  let i = 0
  for (const ch of s) {
    const cw = AMBIGUOUS.has(ch) ? 2 : wideClass(ch.codePointAt(0)!)
    if (w + cw > max - 1) break
    w += cw
    i += ch.length
  }
  return s.slice(0, i) + "\u2026"
}

// --- row assembly helpers --------------------------------------------------

interface Field {
  id: string
  text: string
}

/** Name followed by space-separated fields; no indent. */
function assemble(name: string, fields: readonly string[]): string {
  return fields.length === 0 ? name : name + " " + fields.join(" ")
}

/** Display-column width consumed by fields plus their inter-field separators. */
function fixedWidth(fields: readonly Field[]): number {
  return fields.length === 0
    ? 0
    : fields.reduce((sum, f) => sum + displayWidth(f.text), 0) + fields.length
}

/**
 * Hard truncation using display-column width, not character count.
 * Never returns a string wider than `width` display columns.
 * When truncating, keeps max-1 columns and appends "…" (U+2026).
 */
function clampRow(s: string, width: number): string {
  const n = Math.floor(width)
  if (!(n > 0)) return ""
  const dw = displayWidth(s)
  if (dw <= n) return s
  let w = 0
  let i = 0
  for (const ch of s) {
    const cw = AMBIGUOUS.has(ch) ? 2 : wideClass(ch.codePointAt(0)!)
    if (w + cw > n - 1) break
    w += cw
    i += ch.length
  }
  return s.slice(0, i) + "\u2026"
}

/** Minimum display columns reserved for the name before a field is dropped. */
const MIN_NAME = 12

/** Width below which the minimal tier activates (no │, no second line). */
const TWO_LINE_MIN = 24

/** 6-display-column prefix for continuation lines: "  │   " (bar + 3 spaces).
 *  Sits one step deeper than the caller's "  │▼ " row prefix. */
const CONT_INDENT = "  \u2502   "

// --- core layout -----------------------------------------------------------

/**
 * Build a single display line, dropping fields by identity until the name and
 * remaining fields fit within `width`.  If nothing is left to drop, the name
 * is truncated so trailing fields (cost) survive; `clampRow` then enforces the
 * never-overflow guarantee for the whole line.
 */
function buildLine(
  indent: string,
  name: string,
  fields: Field[],
  droppable: readonly string[],
  width: number
): string {
  let present = fields
  const nameW = displayWidth(name)
  for (;;) {
    const budget = width - displayWidth(indent) - fixedWidth(present)
    if (budget >= MIN_NAME || nameW <= budget) {
      const shown = nameW <= budget ? name : trunc(name, Math.max(budget, 1))
      return clampRow(indent + assemble(shown, present.map((f) => f.text)), width)
    }
    const drop = droppable.find((id) => present.some((f) => f.id === id))
    if (drop === undefined) {
      const shown = nameW <= budget ? name : trunc(name, Math.max(budget, 1))
      return clampRow(indent + assemble(shown, present.map((f) => f.text)), width)
    }
    present = present.filter((f) => f.id !== drop)
  }
}

/** Fixed display width of the agent-name column so counts/speeds line up. */
const AGENT_NAME_WIDTH = 12

/**
 * Detail-line builder: drops `droppable` fields (in order) until the line
 * fits `width`.  Returns null when nothing is left to show.
 */
function buildDetailLine(
  indent: string,
  fields: Field[],
  droppable: readonly string[],
  width: number
): string | null {
  let present = fields
  for (;;) {
    if (present.length === 0) return null
    const line = indent + present.map((f) => f.text).join(" ")
    if (displayWidth(line) <= width) return line
    const drop = droppable.find((id) => present.some((f) => f.id === id))
    if (drop === undefined) return clampRow(line, width)
    present = present.filter((f) => f.id !== drop)
  }
}

/**
 * Split a built line into segments so the token-speed run carries its own
 * tone.  When the speed field is unavailable or was clamped away the whole
 * line is returned as a single muted segment.
 */
function splitTps(line: string, tpsText: string, tone: TpsTone): RowSegment[] {
  if (tone === "none") return [{ text: line }]
  const idx = line.indexOf(tpsText)
  if (idx === -1) return [{ text: line }]
  const segments: RowSegment[] = []
  const before = line.slice(0, idx)
  const after = line.slice(idx + tpsText.length)
  if (before.length > 0) segments.push({ text: before })
  segments.push({ text: tpsText, tps: tone })
  if (after.length > 0) segments.push({ text: after })
  return segments
}

/** Right-pad to exactly `width` display columns; longer names are clipped
 *  with "…" so the following columns stay aligned. */
function padName(s: string, width: number): string {
  let out = s
  if (displayWidth(out) > width) out = trunc(out, width)
  const w = displayWidth(out)
  return w >= width ? out : out + " ".repeat(width - w)
}

// --- token group -----------------------------------------------------------

/** Build the arrow-prefixed token group text: "↑20.0k ↓8.2k ↓r1.2k".
 *  Returns null when all token counts are zero. */
function tokenGroupText(t: GroupTotals): string | null {
  const hasTokens = t.input > 0 || t.output > 0 || t.reasoning > 0
  if (!hasTokens) return null
  const parts: string[] = []
  parts.push("\u2191" + formatTokenCount(t.input))
  parts.push("\u2193" + formatTokenCount(t.output))
  if (t.reasoning > 0) {
    parts.push("\u2193r" + formatTokenCount(t.reasoning))
  }
  return parts.join(" ")
}

// --- model row -------------------------------------------------------------

// --- model display name ----------------------------------------------------

/** Exact display strings (each already <= 10 columns) for known long model ids.
 *  Anything absent from this table is either passed through unchanged (<= 10
 *  columns) or abbreviated by `abbreviateModelId`. */
const MODEL_OVERRIDES: Record<string, string> = {
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

/** Variant word -> collapsed letters. */
const VARIANT_LETTERS: Record<string, string> = {
  flash: "f",
  pro: "p",
  plus: "pl",
  max: "m",
  code: "c",
  omni: "o",
  preview: "pv",
  vision: "v",
  exp: "e",
  luna: "l",
  spark: "sp",
}

/** Brand prefix -> abbreviation.  Brands of <= 4 characters are used as-is. */
const BRAND_ABBREV: Record<string, string> = {
  deepseek: "ds",
  minimax: "mmx",
  mimo: "mm",
  muse: "m",
  qwen: "qw",
  longcat: "lc",
}

/** Marketing-only suffix words that carry no identity. */
const DROPPED_WORDS = new Set(["contributor", "free"])

const VERSION_RE = /^v?\d+(?:\.\d+)*$/
// A brand and version fused into one token, e.g. "hy4" -> ["hy", "4"].
const FUSED_RE = /^([a-z]+)(v?\d+(?:\.\d+)*)$/i

/** Segment after the last "/", so provider prefixes are stripped.  A bare id
 *  with no slash is returned as-is. */
function modelIdSegment(modelKey: string): string {
  const idx = modelKey.lastIndexOf("/")
  return idx === -1 ? modelKey : modelKey.slice(idx + 1)
}

/** Right-pad to exactly 10 display columns; anything longer is clipped with … */
function padToTen(s: string): string {
  let out = s
  if (displayWidth(out) > 10) out = trunc(out, 10)
  const w = displayWidth(out)
  return w >= 10 ? out : out + " ".repeat(10 - w)
}

/** Deterministic abbreviation for ids with no explicit override.  Assembles
 *  `<brand><variantLetters>-<version>`; never empty, never wider than 10 cols. */
function abbreviateModelId(raw: string): string {
  const tokens = raw.split("-").filter((t) => t.length > 0)
  let brand: string | null = null
  let version: string | null = null
  const variant: string[] = []

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (VERSION_RE.test(lower)) {
      if (version === null) version = lower
      continue
    }
    if (DROPPED_WORDS.has(lower)) continue
    const letter = VARIANT_LETTERS[lower]
    if (letter !== undefined) {
      variant.push(letter)
      continue
    }
    const fused = FUSED_RE.exec(lower)
    if (brand === null) {
      if (fused) {
        brand = BRAND_ABBREV[fused[1]] ?? fused[1]
        if (version === null) version = fused[2]
      } else {
        brand = BRAND_ABBREV[lower] ?? lower
      }
      continue
    }
    // Brand already known: a fused brand+version token contributes a version.
    if (fused && version === null) version = fused[2]
  }

  const brandPart = brand ?? ""
  let assembled = brandPart + variant.join("")
  if (version !== null) assembled += brandPart === "" ? version : "-" + version
  if (displayWidth(assembled) === 0) return trunc(raw, 10)
  return assembled
}

/**
 * Exactly-10-display-column model name for the TUI.  Known long ids use the
 * explicit override table; ids of <= 10 columns pass through unchanged and are
 * padded; longer unknown ids are abbreviated deterministically.  Never returns
 * an empty string and never exceeds 10 display columns.
 */
export function modelDisplayName(modelKey: string): string {
  const raw = modelIdSegment(modelKey)
  const override = MODEL_OVERRIDES[raw]
  if (override !== undefined) return padToTen(override)
  if (displayWidth(raw) <= 10) return padToTen(raw)
  return padToTen(abbreviateModelId(raw))
}

// Line 1 fields (headline numbers). Drop order: lat → ttft.
// Token speed and cost are never dropped.
const MODEL_LINE1_DROP = ["lat", "ttft"] as const

// Token detail line. Drop order: hr → tokens.  The request count is never
// dropped, so an expanded model row always has a second line.
const MODEL_LINE2_DROP = ["hr", "tokens"] as const

/**
 * Line 1: `{prefix}{name} {ttft} {tps}tk/s [{lat}] {cost}`
 * Line 2: `{count}r [↑{in} ↓{out} [↓r{r}]] [{hr}%]`
 *
 * `prefix` is caller-supplied so the TUI owns the collapse marker
 * ("  │▼ " / "  │▶ ").  Model rows are always two lines; the request count
 * lives on line 2.  At width < 24 the minimal tier falls back to a single
 * line (name + speed + cost) so the cost survives at extreme widths.
 */
export function formatModelRow(
  prefix: string,
  modelKey: string,
  t: GroupTotals,
  width: number
): RowLines {
  const name = modelDisplayName(modelKey)
  const avg = avgTPS(t)
  const tpsText = formatTPS(avg) + "tk/s"
  const tone = tpsTone(avg)

  // Minimal tier: width < 24 → single line, name + speed + cost
  if (width < TWO_LINE_MIN) {
    const fields: Field[] = [
      { id: "tps", text: tpsText },
      { id: "cost", text: "$" + t.cost.toFixed(4) },
    ]
    const line = buildLine("  ", name, fields, [], width)
    return { line1: splitTps(line, tpsText, tone), line2: null }
  }

  const line1Fields: Field[] = [
    { id: "ttft", text: formatMs(avgTTFT(t)) },
    { id: "tps", text: tpsText },
    { id: "lat", text: formatMs(avgLatency(t)) },
    { id: "cost", text: "$" + t.cost.toFixed(4) },
  ]
  const line1 = buildLine(prefix, name, line1Fields, MODEL_LINE1_DROP, width)

  const line2Fields: Field[] = [{ id: "count", text: String(t.count) + "r" }]
  const tg = tokenGroupText(t)
  if (tg) line2Fields.push({ id: "tokens", text: tg })
  const hr = hitRateOf(t)
  if (hr !== null) line2Fields.push({ id: "hr", text: formatHitPercent(hr) })
  const line2 = buildDetailLine(CONT_INDENT, line2Fields, MODEL_LINE2_DROP, width)

  return { line1: splitTps(line1, tpsText, tone), line2 }
}

// --- agent row -------------------------------------------------------------

// Line 1 fields. Drop order: count → tps.  Token speed and cost are never
// dropped; the request count is only dropped at extreme widths.
const AGENT_LINE1_DROP = ["count", "tps"] as const

// Token detail line. Drop order: hr → tokens.  Returns null when neither fits.
const AGENT_LINE2_DROP = ["hr", "tokens"] as const

/**
 * Line 1: `{prefix}{name} {count}r {tps}tk/s {cost}`
 * Line 2: `[↑{in} ↓{out} [↓r{r}]] [{hr}%]`
 *
 * `prefix` is caller-supplied so the TUI owns the collapse marker.  The name
 * is padded to a fixed column so counts and speeds line up across agents.  At
 * width < 24 the minimal tier falls back to a single line (name + speed +
 * cost) so the cost survives at extreme widths.
 */
export function formatAgentRow(
  prefix: string,
  agentName: string,
  count: number,
  t: GroupTotals,
  width: number
): RowLines {
  const name = padName(agentName, AGENT_NAME_WIDTH)
  const avg = avgTPS(t)
  const tpsText = formatTPS(avg) + "tk/s"
  const tone = tpsTone(avg)

  // Minimal tier
  if (width < TWO_LINE_MIN) {
    const fields: Field[] = [
      { id: "tps", text: tpsText },
      { id: "cost", text: "$" + t.cost.toFixed(4) },
    ]
    const line = buildLine("  ", name, fields, [], width)
    return { line1: splitTps(line, tpsText, tone), line2: null }
  }

  const line1Fields: Field[] = [
    { id: "count", text: String(count) + "r" },
    { id: "tps", text: tpsText },
    { id: "cost", text: "$" + t.cost.toFixed(4) },
  ]
  const line1 = buildLine(prefix, name, line1Fields, AGENT_LINE1_DROP, width)

  const line2Fields: Field[] = []
  const tg = tokenGroupText(t)
  if (tg) line2Fields.push({ id: "tokens", text: tg })
  const hr = hitRateOf(t)
  if (hr !== null) line2Fields.push({ id: "hr", text: formatHitPercent(hr) })
  const line2 = buildDetailLine(CONT_INDENT, line2Fields, AGENT_LINE2_DROP, width)

  return { line1: splitTps(line1, tpsText, tone), line2 }
}
