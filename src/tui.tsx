/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, For, Show } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { LayoutEvents } from "@opentui/core"
import {
  cacheHitRate,
  formatCacheLine,
  hitRateTone,
} from "./cache-rate.js"
import { aggregateBy, type GroupEntryInput } from "./group-stats.js"
import {
  treeSessionIDs,
  type SessionNodeMeta,
} from "./session-tree.js"
import {
  formatModelRow,
  formatAgentRow,
  type RowSegment,
  type TpsTone,
} from "./row-format.js"

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface CompletedEntry extends GroupEntryInput {
  ts: string
  providerID: string
  modelID: string
  messageID: string
  finish: string | undefined
}

interface SessionState {
  entries: CompletedEntry[]
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

// ---------------------------------------------------------------------------
// Session-scoped data store (shared across all slot renders)
// ---------------------------------------------------------------------------

const sessionStates = new Map<string, SessionState>()
const sessionMeta = new Map<string, SessionNodeMeta>()
const firstPartTime = new Map<string, number>()
const firstToolStart = new Map<string, number>()
const seededSessions = new Set<string>()
const backfilledChildren = new Set<string>()

// Dedup set: every messageID that has ever been added via addEntry.
const processedMessages = new Set<string>()

function getOrCreateState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId)
  if (!state) {
    state = { entries: [] }
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
  return true
}

// ---------------------------------------------------------------------------
// Derive CompletedEntry from an AssistantMessage + its parts.
// Shared by every seeding path (sync state API, async client API, live events).
//
// Metric semantics (unchanged from AGENTS.md):
//   TTFT = time.created → first text/reasoning part with a finite time.start
//   TPS  = (output + reasoning) / (genStart → genEnd) where genEnd is the
//          earliest tool state.time.start (tool runtime excluded)
//   latency_ms = time.completed − time.created (end-to-end)
// ---------------------------------------------------------------------------

function deriveEntry(
  sessionId: string,
  a: AssistantMessage,
  parts: readonly { type: string; time?: { start?: number }; state?: { time?: { start?: number } } }[]
): CompletedEntry | null {
  if (!a.time?.completed) return null

  const created = a.time.created
  const completed = a.time.completed
  const latencyMs = completed - created

  // Derive generation window from parts
  let genStart: number | undefined
  let toolStart: number | undefined
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") {
      const start = p.time?.start
      if (genStart === undefined && Number.isFinite(start))
        genStart = start as number
    } else if (p.type === "tool") {
      const start = p.state?.time?.start
      if (Number.isFinite(start)) {
        const s = start as number
        if (toolStart === undefined || s < toolStart) toolStart = s
      }
    }
  }

  let genEnd = toolStart !== undefined ? toolStart : completed
  if (genStart !== undefined && genEnd < genStart) genEnd = completed

  const ttftRaw = genStart !== undefined ? genStart - created : null
  const ttftMs =
    ttftRaw !== null && Number.isFinite(ttftRaw) && ttftRaw >= 0
      ? ttftRaw
      : null

  const outputTokens = a.tokens.output
  const reasoningTokens = a.tokens.reasoning
  const totalGenTokens = outputTokens + reasoningTokens
  const genMs = genStart !== undefined ? genEnd - genStart : null
  const tpsRaw =
    genMs !== null && genMs > 0 && totalGenTokens > 0
      ? (totalGenTokens / genMs) * 1000
      : null
  const tps =
    tpsRaw !== null && Number.isFinite(tpsRaw) && tpsRaw >= 0 ? tpsRaw : null

  return {
    agent: a.agent,
    sessionID: sessionId,
    model: getModelKey(a.providerID, a.modelID),
    providerID: a.providerID,
    modelID: a.modelID,
    ttft_ms: ttftMs,
    tps,
    latency_ms: latencyMs,
    inputTokens: a.tokens.input,
    outputTokens,
    reasoningTokens: a.tokens.reasoning,
    cacheReadTokens: a.tokens.cache.read,
    cacheWriteTokens: a.tokens.cache.write,
    cost: a.cost,
    ts: new Date(completed).toISOString(),
    messageID: a.id,
    finish: a.finish,
  }
}

// ---------------------------------------------------------------------------
// Seeding: reconstruct entries from SDK state when a session is first shown.
// Uses the sync api.state.session.messages (for the root/current session
// which is known-loaded).  Does NOT mark as seeded when the read returns
// nothing, so a later backfill attempt can still fill it in.
// ---------------------------------------------------------------------------

function seedSession(sessionId: string, api: TuiPluginApi) {
  if (seededSessions.has(sessionId)) return

  let messages: ReadonlyArray<{ role: string; [k: string]: unknown }>
  try {
    messages = api.state.session.messages(sessionId)
  } catch {
    return
  }

  // Only mark as seeded AFTER a successful read — if the state API returns
  // nothing, backfillChildren can still try the async client path later.
  let added = 0

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const a = msg as unknown as AssistantMessage

    // Read parts from the state API
    let parts: readonly { type: string; time?: { start?: number }; state?: { time?: { start?: number } } }[] = []
    try {
      parts = api.state.part(a.id) as any
    } catch {
      /* parts may not be available yet */
    }

    const entry = deriveEntry(sessionId, a, parts)
    if (entry && addEntry(sessionId, entry)) added++
  }

  // Mark as seeded only if we actually got data (or at least read the
  // messages successfully — even zero assistant messages is a valid read).
  seededSessions.add(sessionId)
}

// ---------------------------------------------------------------------------
// Backfill child sessions that existed before the plugin loaded.
// Uses the async client API for children (the sync state API may not have
// them loaded).  Recursion into grandchildren stays.
// ---------------------------------------------------------------------------

async function backfillChildren(
  rootID: string,
  api: TuiPluginApi
): Promise<boolean> {
  if (backfilledChildren.has(rootID)) return false
  backfilledChildren.add(rootID)

  let children: Array<{ id: string; parentID?: string; title?: string; agent?: string }> = []
  try {
    const result = await api.client.session.children({ sessionID: rootID })
    if (result.data && Array.isArray(result.data)) {
      children = result.data as any
    }
  } catch {
    return false
  }

  if (children.length === 0) return false

  for (const child of children) {
    if (!child?.id) continue

    // Register child in sessionMeta if not already present
    if (!sessionMeta.has(child.id)) {
      sessionMeta.set(child.id, {
        parentID: child.parentID,
        title: child.title,
        agent: child.agent,
      })
    }

    // Try the sync state API first (fast path — works when the TUI already
    // has this session loaded).
    if (!seededSessions.has(child.id)) {
      seedSession(child.id, api)
    }

    // If still not seeded, use the async client API to get messages directly
    // (the authoritative path for children not yet loaded into the TUI).
    if (!seededSessions.has(child.id)) {
      try {
        const result = await api.client.session.messages({ sessionID: child.id })
        if (result.data && Array.isArray(result.data)) {
          for (const item of result.data as any[]) {
            const msgInfo = item.info
            if (!msgInfo || msgInfo.role !== "assistant") continue
            const a = msgInfo as AssistantMessage
            const parts = item.parts ?? []
            const entry = deriveEntry(child.id, a, parts)
            if (entry) addEntry(child.id, entry)
          }
          // Mark as seeded after successful async read
          seededSessions.add(child.id)
        }
      } catch {
        /* message fetch failed — live events will pick it up */
      }
    }

    // Recurse into grandchildren
    try {
      await backfillChildren(child.id, api)
    } catch {
      /* continue */
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Hit rate color helper
// ---------------------------------------------------------------------------

function hitRateColor(
  rate: number | null,
  theme: TuiThemeCurrent,
  requestCount: number
) {
  const tone = hitRateTone(rate)
  if (tone === "good") return theme.success
  // Fair (40-69%): neutral, default text color — informative, not alarming.
  if (tone === "fair") return theme.text
  // Poor (<40%): only red for genuinely anomalous cases (multiple requests
  // with 0% suggests a caching misconfiguration).  A single request with 0%
  // is normal (cache not yet populated) so stay muted.
  if (tone === "poor" && rate === 0 && requestCount > 1) return theme.error
  return theme.textMuted
}

// ---------------------------------------------------------------------------
// Token-speed color
// ---------------------------------------------------------------------------

/** TPS tone -> theme color.  "none" (speed unavailable) stays muted. */
function tpsColor(tone: TpsTone, theme: TuiThemeCurrent) {
  if (tone === "good") return theme.success
  if (tone === "fair") return theme.warning
  if (tone === "poor") return theme.error
  return theme.textMuted
}

// ---------------------------------------------------------------------------
// ThroughputWidget -- rendered inside the sidebar slot
// ---------------------------------------------------------------------------

interface WidgetProps {
  api: TuiPluginApi
  sessionId: () => string
  tick: () => number
  onDataChange: () => void
}

const MAX_VISIBLE_ROWS = 5

function ThroughputWidget(props: WidgetProps) {
  const [open, setOpen] = createSignal(true)
  const [openModels, setOpenModels] = createSignal(true)
  const [openAgents, setOpenAgents] = createSignal(true)
  // Expanded child rows, keyed "m:<model>" / "a:<agent>".  Default: collapsed.
  const [expandedRows, setExpandedRows] = createSignal(new Set<string>())
  const [paneWidth, setPaneWidth] = createSignal(36)
  const theme = () => props.api.theme.current

  // --- D1: measure the widget's own pane width, not the terminal width ---

  let rootEl: any = null
  let resizeHandler: (() => void) | null = null

  function setRootRef(el: any) {
    if (el === rootEl) return
    // Cleanup only our own listener
    if (rootEl && resizeHandler) {
      rootEl.off(LayoutEvents.RESIZED, resizeHandler)
    }
    rootEl = el
    if (el) {
      // Read initial width
      if (typeof el.width === "number" && el.width > 0) {
        setPaneWidth(el.width)
      }
      // Subscribe to RESIZED to catch terminal resizes
      resizeHandler = () => {
        if (typeof el.width === "number" && el.width > 0) {
          setPaneWidth(el.width)
        }
      }
      el.on(LayoutEvents.RESIZED, resizeHandler)
      // Deferred read: width may not be available on first mount before
      // yoga layout completes.  Try once more after the current event tick.
      setTimeout(() => {
        if (typeof el.width === "number" && el.width > 0) {
          setPaneWidth(el.width)
        }
      }, 0)
    } else {
      resizeHandler = null
    }
  }

  // Seed the current session whenever the reactive sessionId changes.
  createEffect(() => {
    const sid = props.sessionId()
    if (sid) seedSession(sid, props.api)
  })

  // Backfill children for the root session (once per root).
  // This is intentionally fire-and-forget; bump() is called when data lands.
  createEffect(() => {
    const sid = props.sessionId()
    if (sid) {
      // Register root in sessionMeta if not present
      if (!sessionMeta.has(sid)) {
        sessionMeta.set(sid, {})
      }
      backfillChildren(sid, props.api).then((changed) => {
        if (changed) props.onDataChange()
      })
    }
  })

  // Reactive view: recomputes when tick bumps or sessionId changes
  const view = createMemo(() => {
    props.tick() // dependency -- forces recompute on every data change
    const sid = props.sessionId()

    // Collect all entries in the session tree
    const treeIDs = treeSessionIDs(sessionMeta, sid)
    const entries: CompletedEntry[] = []
    for (const id of treeIDs) {
      const state = sessionStates.get(id)
      if (state) {
        for (const e of state.entries) entries.push(e)
      }
    }

    // Session-wide totals
    const totalCount = entries.length
    const totalCost = entries.reduce((s, e) => s + e.cost, 0)
    const totalRead = entries.reduce((s, e) => s + e.cacheReadTokens, 0)
    const totalWrite = entries.reduce((s, e) => s + e.cacheWriteTokens, 0)
    const totalInput = entries.reduce((s, e) => s + e.inputTokens, 0)

    // Per-model aggregation
    const byModel = aggregateBy(entries, (e) => e.model)
    const modelRows = Array.from(byModel.entries())
      .sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]))

    // Per-agent aggregation
    const byAgent = aggregateBy(entries, (e) => e.agent)
    const agentRows = Array.from(byAgent.entries())
      .sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]))

    return {
      totalCount,
      totalCost,
      cacheRead: totalRead,
      cacheWrite: totalWrite,
      inputTokens: totalInput,
      modelRows,
      agentRows,
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

  const hitRateColorMemo = createMemo(() => hitRateColor(hitRate(), theme(), view().totalCount))

  const hitRateText = createMemo(() => {
    const v = view()
    return formatCacheLine({
      read: v.cacheRead,
      input: v.inputTokens,
      write: v.cacheWrite,
    })
  })

  // Split the cache line into three parts so only the percentage carries the
  // tone color.  The label ("  Cache ") and token counts stay textMuted.
  const cacheLineParts = createMemo(() => {
    const text = hitRateText()
    if (!text) return null
    const match = text.match(/(\d+\.?\d*%)/)
    if (!match || match.index === undefined) return { prefix: text, pct: "", suffix: "" }
    return {
      prefix: text.slice(0, match.index),
      pct: match[1],
      suffix: text.slice(match.index + match[1].length),
    }
  })

  function toggleRow(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Row prefix carries the tree bar and the collapse marker.
  function rowPrefix(expanded: boolean): string {
    return "  \u2502" + (expanded ? "\u25bc" : "\u25b6") + " "
  }

  function segmentColor(seg: RowSegment): any {
    return seg.tps ? tpsColor(seg.tps, theme()) : theme().textMuted
  }

  // Width passed to row formatters.  The caller owns the row prefix
  // ("  │▼ " / "  │▶ "), so the budget is the full pane width.
  const w = paneWidth

  return (
    <box ref={setRootRef} width="100%">
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
          <text fg={theme().textMuted}>
            {view().totalCount} reqs
          </text>
          <text fg={theme().textMuted}>
            {"$" + view().totalCost.toFixed(4)}
          </text>
        </Show>
      </box>

      {/* Empty state */}
      <Show when={view().totalCount === 0}>
        <text fg={theme().textMuted}> Waiting for requests...</text>
      </Show>

      {/* Body -- only when expanded and data exists */}
      <Show when={open() && view().totalCount > 0}>
        {/* Session-wide cache hit rate */}
        <Show when={cacheLineParts()}>
          <box flexDirection="row">
            <text fg={theme().textMuted}>{cacheLineParts()!.prefix}</text>
            <text fg={hitRateColorMemo()}>{cacheLineParts()!.pct}</text>
            <text fg={theme().textMuted}>{cacheLineParts()!.suffix}</text>
          </box>
        </Show>

        {/* Models sub-section */}
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => setOpenModels((x) => !x)}
        >
          <text fg={theme().text}>
            {"  " + (openModels() ? "\u25bc " : "\u25b6 ") + "Models"}
          </text>
        </box>
        <Show when={openModels()}>
          <For each={view().modelRows.slice(0, MAX_VISIBLE_ROWS)}>
            {([key, totals]) => {
              const rowKey = "m:" + key
              const isExpanded = () => expandedRows().has(rowKey)
              const lines = () =>
                formatModelRow(rowPrefix(isExpanded()), key, totals, w())
              return (
                <box>
                  <box
                    flexDirection="row"
                    onMouseDown={() => toggleRow(rowKey)}
                  >
                    {lines().line1.map((seg) => (
                      <text fg={segmentColor(seg)}>{seg.text}</text>
                    ))}
                  </box>
                  <Show when={isExpanded() && lines().line2}>
                    <text fg={theme().textMuted}>{lines().line2!}</text>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show
            when={
              view().modelRows.length > MAX_VISIBLE_ROWS
            }
          >
            <text fg={theme().textMuted}>
              {"  +" +
                (view().modelRows.length - MAX_VISIBLE_ROWS) +
                " more models"}
            </text>
          </Show>
        </Show>

        {/* Agents sub-section */}
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => setOpenAgents((x) => !x)}
        >
          <text fg={theme().text}>
            {"  " + (openAgents() ? "\u25bc " : "\u25b6 ") + "Agents"}
          </text>
        </box>
        <Show when={openAgents()}>
          <For
            each={view().agentRows.slice(0, MAX_VISIBLE_ROWS)}
          >
            {([agentName, totals]) => {
              const rowKey = "a:" + agentName
              const isExpanded = () => expandedRows().has(rowKey)
              const lines = () =>
                formatAgentRow(
                  rowPrefix(isExpanded()),
                  agentName,
                  totals.count,
                  totals,
                  w()
                )
              return (
                <box>
                  <box
                    flexDirection="row"
                    onMouseDown={() => toggleRow(rowKey)}
                  >
                    {lines().line1.map((seg) => (
                      <text fg={segmentColor(seg)}>{seg.text}</text>
                    ))}
                  </box>
                  <Show when={isExpanded() && lines().line2}>
                    <text fg={theme().textMuted}>{lines().line2!}</text>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show
            when={
              view().agentRows.length > MAX_VISIBLE_ROWS
            }
          >
            <text fg={theme().textMuted}>
              {"  +" +
                (view().agentRows.length -
                  MAX_VISIBLE_ROWS) +
                " more agents"}
            </text>
          </Show>
        </Show>
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

    if (part.type === "text" || part.type === "reasoning") {
      const p = part as { time?: { start?: number } }
      if (firstPartTime.has(msgID)) return
      const start = p.time?.start
      if (typeof start === "number" && Number.isFinite(start))
        firstPartTime.set(msgID, start)
    } else if (part.type === "tool") {
      const p = part as { state?: { time?: { start?: number } } }
      const start = p.state?.time?.start
      if (typeof start === "number" && Number.isFinite(start)) {
        const existing = firstToolStart.get(msgID)
        if (existing === undefined || start < existing)
          firstToolStart.set(msgID, start)
      }
    }
  })

  // ---- Session tree tracking ----

  api.event.on("session.created", (event) => {
    const info = event.properties.info
    if (!info) return
    sessionMeta.set(info.id, {
      parentID: info.parentID,
      title: info.title,
      agent: info.agent,
    })
  })

  api.event.on("session.updated", (event) => {
    const info = event.properties.info
    if (!info) return
    const existing = sessionMeta.get(info.id)
    if (existing) {
      if (info.parentID !== undefined) existing.parentID = info.parentID
      if (info.title !== undefined) existing.title = info.title
      if (info.agent !== undefined) existing.agent = info.agent
    } else {
      sessionMeta.set(info.id, {
        parentID: info.parentID,
        title: info.title,
        agent: info.agent,
      })
    }
  })

  api.event.on("session.deleted", (event) => {
    const info = event.properties.info
    if (!info) return
    const existing = sessionMeta.get(info.id)
    if (existing) existing.deleted = true
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

      const genStart = firstPartTime.get(msgID)
      const toolStart = firstToolStart.get(msgID)
      let genEnd = toolStart !== undefined ? toolStart : completed
      if (genStart !== undefined && genEnd < genStart) genEnd = completed

      const ttftRaw = genStart !== undefined ? genStart - created : null
      const ttftMs =
        ttftRaw !== null && Number.isFinite(ttftRaw) && ttftRaw >= 0
          ? ttftRaw
          : null

      const outputTokens = info.tokens?.output ?? 0
      const reasoningTokens = info.tokens?.reasoning ?? 0
      const totalGenTokens = outputTokens + reasoningTokens
      const genMs = genStart !== undefined ? genEnd - genStart : null
      const tpsRaw =
        genMs !== null && genMs > 0 && totalGenTokens > 0
          ? (totalGenTokens / genMs) * 1000
          : null
      const tps =
        tpsRaw !== null && Number.isFinite(tpsRaw) && tpsRaw >= 0
          ? tpsRaw
          : null

      const providerID = info.providerID ?? ""
      const modelID = info.modelID ?? ""

      addEntry(sessionId, {
        agent: info.agent,
        sessionID: sessionId,
        model: getModelKey(providerID, modelID),
        providerID,
        modelID,
        ttft_ms: ttftMs,
        tps,
        latency_ms: latencyMs,
        inputTokens: info.tokens?.input ?? 0,
        outputTokens,
        reasoningTokens,
        cacheReadTokens: info.tokens?.cache?.read ?? 0,
        cacheWriteTokens: info.tokens?.cache?.write ?? 0,
        cost: info.cost ?? 0,
        ts: new Date().toISOString(),
        messageID: msgID,
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
        const sid = () => slotProps.session_id
        setActiveSessionId(slotProps.session_id)

        return (
          <ThroughputWidget
            api={api}
            sessionId={sid}
            tick={tick}
            onDataChange={bump}
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
