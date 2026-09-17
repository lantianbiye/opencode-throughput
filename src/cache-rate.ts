// Pure prompt-cache arithmetic and formatting for the throughput TUI panel.
//
// Hit-rate semantics (deliberately chosen): the share of prompt tokens that were
// served from the prompt cache, out of ALL prompt tokens sent:
//
//   hitRate = cacheRead / (cacheRead + uncachedInput + cacheWrite)
//
// A cache write is therefore treated as a miss on the request that performed it,
// so the number is not inflated by the first request that populates the cache.
//
// Why the denominator is the true prompt total (not a double count): opencode
// normalizes the three buckets to be non-overlapping before they reach a plugin.
// `Session.getUsage` in opencode's packages/opencode/src/session/session.ts does:
//
//   const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)
//
// with the documented invariant (packages/llm/src/schema/events.ts):
//
//   nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens = inputTokens
//
// So `tokens.input` is the NON-cached prompt share, `cacheRead > input` is normal
// (measured on real opencode-go traffic: input 153 / cacheRead 20096 in one request),
// and output + reasoning tokens are never part of this ratio.
//
// Version note: that subtraction is only tuned for opencode running AI SDK v6+.
// On an older build whose providers still report Anthropic-style non-inclusive
// input, the subtraction can clamp `input` to 0 and inflate this rate --
// `input === 0 && read > 0` on a multi-turn session is the tell-tale.

export interface PromptTokens {
  /** prompt tokens served from the cache (tokens.cache.read) */
  read: number
  /** uncached prompt tokens (tokens.input) */
  input: number
  /** prompt tokens written into the cache (tokens.cache.write) */
  write: number
}

export function promptTokensTotal(tokens: PromptTokens): number {
  return tokens.read + tokens.input + tokens.write
}

/** Fraction in 0..1, or null when no prompt tokens have been observed yet. */
export function cacheHitRate(tokens: PromptTokens): number | null {
  const total = promptTokensTotal(tokens)
  if (!Number.isFinite(total) || total <= 0) return null
  return tokens.read / total
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "N/A"
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return String(Math.round(n))
}

/**
 * Sidebar line, e.g. "  Cache 83.2% 12.3k/14.8k"
 * (percentage in 0..100 scale, numerator = cached tokens, denominator = all prompt tokens).
 * Returns null when there is nothing to show.
 */
export function formatCacheLine(tokens: PromptTokens): string | null {
  const rate = cacheHitRate(tokens)
  if (rate === null) return null
  return (
    "  Cache " +
    (rate * 100).toFixed(1) +
    "% " +
    formatTokenCount(tokens.read) +
    "/" +
    formatTokenCount(promptTokensTotal(tokens))
  )
}
