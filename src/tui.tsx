/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, For, Show } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import {
  cacheHitRate,
  formatCacheLine,
  formatTokenCount,
} from "./cache-rate.js"

// ---------------------------------------------------------------------------
// Local types (avoids importing from ../types.ts which is owned by another lane)
// ---------------------------------------------------------------------------

interface CompletedEntry {
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

interface ModelStats {
  model: string
  count: number
  avgTTFT: number
  avgTPS: number
  avgLatency: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
}

interface SessionState {
  entries: CompletedEntry[]
  stats: Map<string, ModelStats>
  cacheRead: number
  cacheWrite: number
  inputTokens: number
}

// ---------------------------------------------------------------------------
// Formatting utilities (standalone -- no external imports)
// ---------------------------------------------------------------------------

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

function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "." : s
}

// ---------------------------------------------------------------------------
// Per-model aggregate update (mirrors stats.ts logic)
// ---------------------------------------------------------------------------

function updateStats(
  stats: Map<string, ModelStats>,
  key: string,
  entry: CompletedEntry
) {
  const existing = stats.get(key)
  if (!existing) {
    stats.set(key, {
      model: key,
      count: 1,
      avgTTFT: entry.ttft_ms ?? 0,
      avgTPS: entry.tps ?? 0,
      avgLatency: entry.latency_ms ?? 0,
      totalInputTokens: entry.inputTokens,
      totalOutputTokens: entry.outputTokens,
      totalCost: entry.cost,
    })
    return
  }
  const c = existing.count + 1
  existing.count = c
  existing.avgTTFT = (existing.avgTTFT * (c - 1) + (entry.ttft_ms ?? 0)) / c
  existing.avgTPS = (existing.avgTPS * (c - 1) + (entry.tps ?? 0)) / c
  existing.avgLatency =
    (existing.avgLatency * (c - 1) + (entry.latency_ms ?? 0)) / c
  existing.totalInputTokens += entry.inputTokens
  existing.totalOutputTokens += entry.outputTokens
  existing.totalCost += entry.cost
  stats.set(key, existing)
}

// ---------------------------------------------------------------------------
// Session-scoped data store  (shared across all slot renders)
// ---------------------------------------------------------------------------

const sessionStates = new Map<string, SessionState>()
const firstPartTime = new Map<string, number>()
const firstToolStart = new Map<string, number>()
const seededSessions = new Set<string>()

// Dedup set: every messageID that has ever been added via addEntry, whether
// from seeding or from a live event.  This guarantees each completed assistant
// message is counted exactly once regardless of which path reaches it first.
const processedMessages = new Set<string>()

function getOrCreateState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId)
  if (!state) {
    state = {
      entries: [],
      stats: new Map(),
      cacheRead: 0,
      cacheWrite: 0,
      inputTokens: 0,
    }
    sessionStates.set(sessionId, state)
  }
  return state
}

/** Add an entry ONLY if its messageID has not been processed before. */
function addEntry(sessionId: string, entry: CompletedEntry): boolean {
  if (processedMessages.has(entry.messageID)) return false
  processedMessages.add(entry.messageID)

  const state = getOrCreateState(sessionId)
  state.entries.push(entry)
  updateStats(state.stats, entry.model, entry)
  state.cacheRead += entry.cacheReadTokens
  state.cacheWrite += entry.cacheWriteTokens
  state.inputTokens += entry.inputTokens
  return true
}

// ---------------------------------------------------------------------------
// Seeding: reconstruct aggregates from SDK state when a session is first shown
// ---------------------------------------------------------------------------

function seedSession(sessionId: string, api: TuiPluginApi) {
  if (seededSessions.has(sessionId)) return
  seededSessions.add(sessionId)

  let messages: ReadonlyArray<{ role: string; [k: string]: unknown }>
  try {
    messages = api.state.session.messages(sessionId)
  } catch {
    return
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const a = msg as unknown as AssistantMessage
    if (!a.time?.completed) continue

    const created = a.time.created
    const completed = a.time.completed
    const latencyMs = completed - created

    // Derive generation window from parts:
    //   genStart = first text/reasoning part with a finite time.start
    //   genEnd   = earliest tool state.time.start (tool runtime excluded)
    let genStart: number | undefined
    let toolStart: number | undefined
    try {
      for (const part of api.state.part(a.id)) {
        const p = part as any
        if (p.type === "text" || p.type === "reasoning") {
          const start = p.time?.start
          if (genStart === undefined && Number.isFinite(start)) genStart = start as number
        } else if (p.type === "tool") {
          const start = p.state?.time?.start
          if (Number.isFinite(start)) {
            const s = start as number
            if (toolStart === undefined || s < toolStart) toolStart = s
          }
        }
      }
    } catch {
      /* parts may not be available yet */
    }

    let genEnd = toolStart !== undefined ? toolStart : completed
    if (genStart !== undefined && genEnd < genStart) genEnd = completed

    const ttftRaw = genStart !== undefined ? genStart - created : null
    const ttftMs =
      ttftRaw !== null && Number.isFinite(ttftRaw) && ttftRaw >= 0 ? ttftRaw : null

    const outputTokens = a.tokens.output
    const reasoningTokens = a.tokens.reasoning
    const totalGenTokens = outputTokens + reasoningTokens
    const genMs = genStart !== undefined ? genEnd - genStart : null
    const tpsRaw =
      genMs !== null && genMs > 0 && totalGenTokens > 0
        ? (totalGenTokens / genMs) * 1000
        : null
    const tps = tpsRaw !== null && Number.isFinite(tpsRaw) && tpsRaw >= 0 ? tpsRaw : null

    addEntry(sessionId, {
      ts: new Date(completed).toISOString(),
      model: getModelKey(a.providerID, a.modelID),
      providerID: a.providerID,
      modelID: a.modelID,
      sessionID: sessionId,
      messageID: a.id,
      ttft_ms: ttftMs,
      tps,
      latency_ms: latencyMs,
      inputTokens: a.tokens.input,
      outputTokens,
      reasoningTokens: a.tokens.reasoning,
      cacheReadTokens: a.tokens.cache.read,
      cacheWriteTokens: a.tokens.cache.write,
      cost: a.cost,
      finish: a.finish,
    })
  }
}

// ---------------------------------------------------------------------------
// Display format helpers
// ---------------------------------------------------------------------------

const MODEL_MAX = 28

function formatModelStatsLine(s: ModelStats): string {
  const model = trunc(s.model.split("/").pop() ?? s.model, MODEL_MAX)
  return [
    model,
    formatMs(s.avgTTFT),
    formatNum(s.avgTPS) + "/s",
    formatMs(s.avgLatency),
    "\u2191" + formatTokenCount(s.totalInputTokens),
    "\u2193" + formatTokenCount(s.totalOutputTokens),
    "$" + s.totalCost.toFixed(4),
  ].join(" ")
}

// ---------------------------------------------------------------------------
// ThroughputWidget -- rendered inside the sidebar slot
// ---------------------------------------------------------------------------

interface WidgetProps {
  api: TuiPluginApi
  sessionId: () => string
  tick: () => number
}

function ThroughputWidget(props: WidgetProps) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  // Seed the current session whenever the reactive sessionId changes.
  // seedSession is idempotent (guarded by seededSessions Set).
  createEffect(() => {
    const sid = props.sessionId()
    if (sid) seedSession(sid, props.api)
  })

  // Reactive view: recomputes when tick bumps or sessionId changes
  const view = createMemo(() => {
    props.tick() // dependency -- forces recompute on every data change
    const sid = props.sessionId()
    const state = sessionStates.get(sid)
    if (!state) {
      return {
        stats: [] as ModelStats[],
        totalCount: 0,
        totalCost: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokens: 0,
      }
    }
    return {
      stats: Array.from(state.stats.values()),
      totalCount: state.entries.length,
      totalCost: state.entries.reduce((s, e) => s + e.cost, 0),
      cacheRead: state.cacheRead,
      cacheWrite: state.cacheWrite,
      inputTokens: state.inputTokens,
    }
  })

  // Cache hit rate -- null when there is nothing to compute
  const hitRate = createMemo(() =>
    cacheHitRate({
      read: view().cacheRead,
      input: view().inputTokens,
      write: view().cacheWrite,
    })
  )

  const hitRateColor = createMemo(() => {
    const hr = hitRate()
    if (hr === null) return theme().textMuted
    if (hr >= 0.7) return theme().success
    if (hr >= 0.4) return theme().warning
    return theme().error
  })

  const hitRateText = createMemo(() => {
    const v = view()
    return formatCacheLine({
      read: v.cacheRead,
      input: v.inputTokens,
      write: v.cacheWrite,
    })
  })

  return (
    <box>
      {/* Header row */}
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => view().totalCount > 0 && setOpen((x) => !x)}
      >
        <Show when={view().totalCount > 0}>
          <text fg={theme().text}>{open() ? "\u25bc" : "\u25b6"}</text>
        </Show>
        <text fg={theme().text}>
          <b>Throughput</b>
        </text>
        <Show when={view().totalCount > 0}>
          <text fg={theme().textMuted}>{view().totalCount} reqs</text>
          <text fg={theme().textMuted}>{"$" + view().totalCost.toFixed(4)}</text>
        </Show>
      </box>

      {/* Empty state */}
      <Show when={view().totalCount === 0}>
        <text fg={theme().textMuted}> Waiting for requests...</text>
      </Show>

      {/* Body -- only when expanded and data exists */}
      <Show when={open() && view().totalCount > 0}>
        {/* Cache hit rate */}
        <Show when={hitRateText()}>
          <text fg={hitRateColor()}>{hitRateText()}</text>
        </Show>

        {/* Per-model aggregate lines */}
        <For each={view().stats}>
          {(s) => (
            <text fg={theme().textMuted}>{"  " + formatModelStatsLine(s)}</text>
          )}
        </For>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const id = "opencode-throughput-tui"

const tui = async (api: TuiPluginApi) => {
  const [tick, setTick] = createSignal(0)
  const [activeSessionId, setActiveSessionId] = createSignal("")

  function bump() {
    setTick((t) => t + 1)
  }

  // ---- TTFT tracking via part events ----

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (!part) return
    const msgID = part.messageID
    if (!msgID) return

    // Only TextPart / ReasoningPart carry a meaningful time.start; every other
    // part type is ignored (no Date.now() fallback).
    if (part.type === "text" || part.type === "reasoning") {
      const p = part as { time?: { start?: number } }
      if (firstPartTime.has(msgID)) return
      const start = p.time?.start
      if (typeof start === "number" && Number.isFinite(start)) firstPartTime.set(msgID, start)
    } else if (part.type === "tool") {
      // ToolPart.state.time.start = when a tool began executing; keep the min.
      const p = part as { state?: { time?: { start?: number } } }
      const start = p.state?.time?.start
      if (typeof start === "number" && Number.isFinite(start)) {
        const existing = firstToolStart.get(msgID)
        if (existing === undefined || start < existing) firstToolStart.set(msgID, start)
      }
    }
  })

  // ---- Completed assistant messages ----

  api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info?.role !== "assistant") return

    const msgID = info.id
    const sessionId = event.properties.sessionID

    if (info.time?.completed) {
      const created = info.time.created
      const completed = info.time.completed
      if (!created || !completed) {
        firstPartTime.delete(msgID)
        firstToolStart.delete(msgID)
        return
      }

      const latencyMs = completed - created

      // genStart: first text/reasoning part with a finite time.start.
      // genEnd: earliest observed tool execution start (or completed).
      const genStart = firstPartTime.get(msgID)
      const toolStart = firstToolStart.get(msgID)
      let genEnd = toolStart !== undefined ? toolStart : completed
      if (genStart !== undefined && genEnd < genStart) genEnd = completed

      const ttftRaw = genStart !== undefined ? genStart - created : null
      const ttftMs =
        ttftRaw !== null && Number.isFinite(ttftRaw) && ttftRaw >= 0 ? ttftRaw : null

      const outputTokens = info.tokens?.output ?? 0
      const reasoningTokens = info.tokens?.reasoning ?? 0
      const totalGenTokens = outputTokens + reasoningTokens
      const genMs = genStart !== undefined ? genEnd - genStart : null
      const tpsRaw =
        genMs !== null && genMs > 0 && totalGenTokens > 0
          ? (totalGenTokens / genMs) * 1000
          : null
      const tps = tpsRaw !== null && Number.isFinite(tpsRaw) && tpsRaw >= 0 ? tpsRaw : null

      const providerID = info.providerID ?? ""
      const modelID = info.modelID ?? ""

      addEntry(sessionId, {
        ts: new Date().toISOString(),
        model: getModelKey(providerID, modelID),
        providerID,
        modelID,
        sessionID: sessionId,
        messageID: msgID,
        ttft_ms: ttftMs,
        tps,
        latency_ms: latencyMs,
        inputTokens: info.tokens?.input ?? 0,
        outputTokens,
        reasoningTokens,
        cacheReadTokens: info.tokens?.cache?.read ?? 0,
        cacheWriteTokens: info.tokens?.cache?.write ?? 0,
        cost: info.cost ?? 0,
        finish: info.finish,
      })

      firstPartTime.delete(msgID)
      firstToolStart.delete(msgID)
      bump()
    }
  })

  // ---- Cleanup on removal / error ----

  api.event.on("message.removed", (event) => {
    const msgID = event.properties.messageID
    if (msgID) {
      firstPartTime.delete(msgID)
      firstToolStart.delete(msgID)
    }
  })

  api.event.on("session.error", () => {
    firstPartTime.clear()
    firstToolStart.clear()
  })

  // ---- Sidebar slot ----

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx, slotProps) {
        // Pass session_id as a reactive getter so the widget is robust
        // regardless of whether the host re-invokes this handler on session
        // switch.  seedSession() is called inside the widget via createEffect
        // and is idempotent (guarded by the seededSessions Set).
        const sid = () => slotProps.session_id

        // Harmless fallback: also track via signal for any direct reader.
        setActiveSessionId(slotProps.session_id)

        return (
          <ThroughputWidget
            api={api}
            sessionId={sid}
            tick={tick}
          />
        )
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { tui }

export default {
  id,
  tui,
}
