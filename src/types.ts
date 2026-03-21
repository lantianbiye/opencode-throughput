export type LogEntry = {
  ts: string
  model: string
  providerID: string
  modelID: string
  sessionID: string
  messageID: string
  ttft_ms: number | null
  tps: number | null
  latency_ms: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  finish: string | undefined
}

export type ModelStats = {
  model: string
  count: number
  avgTTFT: number
  avgTPS: number
  avgLatency: number
  minTTFT: number
  maxTTFT: number
  minLatency: number
  maxLatency: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCost: number
  lastUpdated: number
}
