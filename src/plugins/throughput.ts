import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { LogEntry } from "../types.js"
import path from "path"
import fs from "fs"
import os from "os"

// Resolved lazily (at call time) so tests can point OPENCODE_THROUGHPUT_LOG at
// a temp file after this module is imported. When unset, behavior is identical
// to the historical hard-coded path: ~/.opencode/throughput.jsonl
function logFile(): string {
  return (
    process.env.OPENCODE_THROUGHPUT_LOG ??
    path.join(os.homedir(), ".opencode", "throughput.jsonl")
  )
}

function ensureLogDir() {
  const dir = path.dirname(logFile())
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function formatNum(n: number | null): string {
  if (n == null) return "N/A"
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return n.toFixed(n >= 100 ? 0 : 1)
}

function formatMs(ms: number | null): string {
  if (ms == null) return "N/A"
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m"
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s"
  return ms.toFixed(0) + "ms"
}

function appendLog(entry: LogEntry) {
  ensureLogDir()
  const line = JSON.stringify(entry) + "\n"
  fs.appendFileSync(logFile(), line, "utf-8")
}

function buildLogMsg(entry: LogEntry): string {
  const shortModel =
    entry.modelID.length > 28 ? entry.modelID.slice(0, 26) + ".." : entry.modelID
  const parts = [
    shortModel,
    formatMs(entry.ttft_ms) + " TTFT",
    formatNum(entry.tps) + " tok/s",
    formatMs(entry.latency_ms),
    "\u2191" + formatNum(entry.inputTokens) + " \u2193" + formatNum(entry.outputTokens),
  ]
  return parts.join(" | ")
}

function readLogs(): LogEntry[] {
  const file = logFile()
  if (!fs.existsSync(file)) return []
  const content = fs.readFileSync(file, "utf-8")
  return content
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l) as LogEntry)
}

const benchmarkTool = tool({
  description:
    "Query model performance benchmarks including latency, throughput (TTFT, TPS), token usage, and cost. Shows stats aggregated by model.",
  args: {
    model: tool.schema
      .string()
      .optional()
      .describe(
        "Filter by model name (partial match, e.g. 'claude' or 'gpt'). Omit for all models."
      ),
    last: tool.schema
      .number()
      .optional()
      .describe("Only show the last N entries (default: show all)"),
  },
  async execute(args) {
    const logs = readLogs()

    if (logs.length === 0) {
      return "No benchmark data yet. The throughput plugin needs to process at least one LLM response before stats are available."
    }

    const keyword = args.model?.toLowerCase()
    const filtered = keyword
      ? logs.filter(
          (l: LogEntry) =>
            l.model.toLowerCase().includes(keyword) ||
            l.modelID.toLowerCase().includes(keyword)
        )
      : logs

    const sliced = args.last ? filtered.slice(-args.last) : filtered

    const byModel = new Map<string, LogEntry[]>()

    for (const entry of sliced) {
      const arr = byModel.get(entry.model) ?? []
      arr.push(entry)
      byModel.set(entry.model, arr)
    }

    const lines: string[] = []
    lines.push(`## Model Performance Benchmark`)
    lines.push(`Total requests: ${sliced.length}`)
    if (args.model) lines.push(`Filter: ${args.model}`)
    lines.push(``)

    for (const [model, entries] of byModel) {
      const count = entries.length
      const ttfts = entries
        .filter((e: LogEntry) => e.ttft_ms != null)
        .map((e: LogEntry) => e.ttft_ms!)
      const latencies = entries
        .filter((e: LogEntry) => e.latency_ms != null)
        .map((e: LogEntry) => e.latency_ms!)
      const tpsList = entries
        .filter((e: LogEntry) => e.tps != null)
        .map((e: LogEntry) => e.tps!)

      const avgTTFT =
        ttfts.length > 0 ? ttfts.reduce((a: number, b: number) => a + b, 0) / ttfts.length : null
      const minTTFT = ttfts.length > 0 ? Math.min(...ttfts) : null
      const maxTTFT = ttfts.length > 0 ? Math.max(...ttfts) : null

      const avgLatency =
        latencies.length > 0
          ? latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length
          : null
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : null
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : null

      const avgTPS =
        tpsList.length > 0
          ? tpsList.reduce((a: number, b: number) => a + b, 0) / tpsList.length
          : null
      const maxTPS = tpsList.length > 0 ? Math.max(...tpsList) : null

      const totalInput = entries.reduce((s: number, e: LogEntry) => s + e.inputTokens, 0)
      const totalOutput = entries.reduce((s: number, e: LogEntry) => s + e.outputTokens, 0)
      const totalReasoning = entries.reduce(
        (s: number, e: LogEntry) => s + e.reasoningTokens,
        0
      )
      const totalCacheRead = entries.reduce(
        (s: number, e: LogEntry) => s + e.cacheReadTokens,
        0
      )
      const totalCacheWrite = entries.reduce(
        (s: number, e: LogEntry) => s + e.cacheWriteTokens,
        0
      )
      const totalCost = entries.reduce((s: number, e: LogEntry) => s + e.cost, 0)

      lines.push(`### ${model}`)
      lines.push(`  Requests: ${count}`)
      lines.push(``)
      lines.push(`  **Latency:**`)
      lines.push(
        `    TTFT:  avg ${formatMs(avgTTFT)} | min ${formatMs(minTTFT)} | max ${formatMs(maxTTFT)}`
      )
      lines.push(
        `    Total: avg ${formatMs(avgLatency)} | min ${formatMs(minLatency)} | max ${formatMs(maxLatency)}`
      )
      lines.push(``)
      lines.push(`  **Throughput:**`)
      lines.push(`    TPS:  avg ${formatNum(avgTPS)} | max ${formatNum(maxTPS)}`)
      lines.push(``)
      lines.push(`  **Tokens:**`)
      lines.push(`    Input:     ${formatNum(totalInput)}`)
      lines.push(`    Output:    ${formatNum(totalOutput)}`)
      lines.push(`    Reasoning: ${formatNum(totalReasoning)}`)
      lines.push(`    Cache R/W: ${formatNum(totalCacheRead)} / ${formatNum(totalCacheWrite)}`)
      lines.push(``)
      lines.push(`  **Cost:** $${totalCost.toFixed(4)}`)

      if (entries.length <= 5) {
        lines.push(``)
        lines.push(`  Recent entries:`)
        for (const e of entries) {
          lines.push(
            `    ${e.ts} | ${formatMs(e.ttft_ms)} TTFT | ${formatNum(e.tps)} tok/s | ${formatMs(e.latency_ms)} | cost $${e.cost.toFixed(4)}`
          )
        }
      }

      lines.push(``)
    }

    return lines.join("\n")
  },
})

export const ThroughputPlugin: Plugin = async ({ client, directory }) => {
  const firstPartTime = new Map<string, number>()
  const firstToolStart = new Map<string, number>()
  const msgCreatedTime = new Map<string, number>()

  function writePerfFile(entry: LogEntry) {
    if (!directory) return
    const throughputFile = path.join(directory, ".opencode", "throughput.md")

    const line = `${entry.ts} | ${entry.modelID} | TTFT ${formatMs(entry.ttft_ms)} | TPS ${formatNum(entry.tps)} tok/s | Latency ${formatMs(entry.latency_ms)} | ↑${formatNum(entry.inputTokens)} ↓${formatNum(entry.outputTokens)} ↓r${formatNum(entry.reasoningTokens)} | Cost $${entry.cost.toFixed(4)}${entry.finish && entry.finish !== "stop" ? " | " + entry.finish : ""}\n`

    try {
      fs.mkdirSync(path.dirname(throughputFile), { recursive: true })
      fs.appendFileSync(throughputFile, line, "utf-8")
    } catch {}
  }

  return {
    tool: {
      benchmark: benchmarkTool,
    },

    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info as any
        if (info?.role !== "assistant") return

        const msgID = info.id as string

        if (info.time?.created && !msgCreatedTime.has(msgID)) {
          msgCreatedTime.set(msgID, info.time.created)
        }

        if (info.time?.completed) {
          const created = info.time.created as number
          const completed = info.time.completed as number

          if (!created || !completed) {
            firstPartTime.delete(msgID)
            firstToolStart.delete(msgID)
            msgCreatedTime.delete(msgID)
            return
          }

          const latencyMs = completed - created

          // genStart: first text/reasoning part carrying a finite time.start.
          // genEnd: earliest observed tool execution start (or completed).
          const genStart = firstPartTime.get(msgID)
          const toolStart = firstToolStart.get(msgID)
          let genEnd = toolStart !== undefined ? toolStart : completed
          if (genStart !== undefined && genEnd < genStart) genEnd = completed

          const ttftRaw = genStart !== undefined ? genStart - created : null
          const ttftMs =
            ttftRaw !== null && Number.isFinite(ttftRaw) && ttftRaw >= 0 ? ttftRaw : null

          const outputTokens = (info.tokens?.output as number) ?? 0
          const reasoningTokens = (info.tokens?.reasoning as number) ?? 0
          const totalGenTokens = outputTokens + reasoningTokens

          const genMs = genStart !== undefined ? genEnd - genStart : null
          const tpsRaw =
            genMs !== null && genMs > 0 && totalGenTokens > 0
              ? (totalGenTokens / genMs) * 1000
              : null
          const tps = tpsRaw !== null && Number.isFinite(tpsRaw) && tpsRaw >= 0 ? tpsRaw : null

          const providerID = (info.providerID as string) ?? ""
          const modelID = (info.modelID as string) ?? ""
          const modelKey = getModelKey(providerID, modelID)

          const entry: LogEntry = {
            ts: new Date().toISOString(),
            model: modelKey,
            providerID,
            modelID,
            sessionID: info.sessionID as string,
            messageID: msgID,
            ttft_ms: ttftMs,
            tps,
            latency_ms: latencyMs,
            inputTokens: (info.tokens?.input as number) ?? 0,
            outputTokens,
            reasoningTokens,
            cacheReadTokens: (info.tokens?.cache?.read as number) ?? 0,
            cacheWriteTokens: (info.tokens?.cache?.write as number) ?? 0,
            cost: (info.cost as number) ?? 0,
            finish: info.finish as string | undefined,
          }

          appendLog(entry)
          writePerfFile(entry)

          const logMsg = buildLogMsg(entry)
          const variant = entry.finish === "error" ? "warn" : "info"
          const toastVariant: "info" | "success" | "warning" | "error" =
            entry.finish === "error" ? "warning" : "info"

          try {
            await client.tui.showToast({
              body: {
                title: "Throughput",
                message: logMsg,
                variant: toastVariant,
                duration: 4000,
              },
            })
          } catch {}

          try {
            await client.app.log({
              body: {
                service: "opencode-throughput",
                level: variant,
                message: logMsg,
                extra: {
                  model: entry.model,
                  ttft_ms: entry.ttft_ms,
                  tps: entry.tps,
                  latency_ms: entry.latency_ms,
                  inputTokens: entry.inputTokens,
                  outputTokens: entry.outputTokens,
                  cost: entry.cost,
                },
              },
            })
          } catch {}

          firstPartTime.delete(msgID)
          firstToolStart.delete(msgID)
          msgCreatedTime.delete(msgID)
        }
      }

      if (event.type === "message.removed") {
        const props = event.properties as any
        const msgID = props?.info?.id ?? props?.messageID
        if (msgID) {
          firstPartTime.delete(msgID as string)
          firstToolStart.delete(msgID as string)
          msgCreatedTime.delete(msgID as string)
        }
      }

      if (event.type === "session.error") {
        firstPartTime.clear()
        firstToolStart.clear()
        msgCreatedTime.clear()
      }

      if (event.type === "message.part.updated") {
        const part = (event.properties as any).part as any
        if (!part) return

        const msgID = part.messageID as string
        if (!msgID) return

        // Only TextPart / ReasoningPart carry a meaningful time.start.
        if (part.type === "text" || part.type === "reasoning") {
          const start = part.time?.start
          if (Number.isFinite(start) && !firstPartTime.has(msgID)) {
            firstPartTime.set(msgID, start as number)
          }
        } else if (part.type === "tool") {
          // ToolPart.state.time.start = when the first tool began executing.
          const start = part.state?.time?.start
          if (Number.isFinite(start)) {
            const existing = firstToolStart.get(msgID)
            if (existing === undefined || (start as number) < existing) {
              firstToolStart.set(msgID, start as number)
            }
          }
        }
      }
    },
  }
}

export default ThroughputPlugin
