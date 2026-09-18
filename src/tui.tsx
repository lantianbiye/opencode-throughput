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
import {
  aggregateBy,
  type GroupTotals,
  type GroupEntryInput,
} from "./group-stats.js"
import {
  treeSessionIDs,
  type SessionNodeMeta,
} from "./session-tree.js"
import { formatModelRow, formatAgentRow, formatChildRow } from "./row-format.js"

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

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "." : s
}

function sessionLabel(
  meta: Map<string, SessionNodeMeta>,
  sid: string,
  rootID: string
): string {
  const node = meta.get(sid)
  const title = node?.title
  if (title && title.length > 0) {
    return trunc(title, sid === rootID ? 13 : 14)
  }
  return sid.slice(0, 8) + "\u2026"
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
  theme: TuiThemeCurrent
) {
  const tone = hitRateTone(rate)
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
  const [openAgents, setOpenAgents] = createSignal(false)
  const [expandedAgents, setExpandedAgents] = createSignal(
    new Set<string>()
  )
  const [paneWidth, setPaneWidth] = createSignal(44)
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

    // Per-agent per-session detail (for expanded agent rows)
    const agentSessions = new Map<
      string,
      Array<{
        sessionID: string
        totals: GroupTotals
        timeCreated: number
      }>
    >()
    for (const agentName of byAgent.keys()) {
      const agentEntries = entries.filter((e) => e.agent === agentName)
      const bySession = aggregateBy(agentEntries, (e) => e.sessionID)
      const sessions = Array.from(bySession.entries())
        .map(([sid, totals]) => {
          const earliest = agentEntries
            .filter((e) => e.sessionID === sid)
            .reduce(
              (min, e) => Math.min(min, new Date(e.ts).getTime()),
              Infinity
            )
          return { sessionID: sid, totals, timeCreated: earliest }
        })
        .sort(
          (a, b) =>
            b.totals.cost - a.totals.cost ||
            a.timeCreated - b.timeCreated
        )
      agentSessions.set(agentName, sessions)
    }

    return {
      totalCount,
      totalCost,
      cacheRead: totalRead,
      cacheWrite: totalWrite,
      inputTokens: totalInput,
      modelRows,
      agentRows,
      agentSessions,
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

  const hitRateColorMemo = createMemo(() => hitRateColor(hitRate(), theme()))

  const hitRateText = createMemo(() => {
    const v = view()
    return formatCacheLine({
      read: v.cacheRead,
      input: v.inputTokens,
      write: v.cacheWrite,
    })
  })

  function toggleAgent(name: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Width passed to row formatters.
  // Model row: full pane width, formatter owns 2-space indent.
  // Child row: full pane width, formatter owns 4-space indent and "*".
  // Agent row: (paneWidth - 4), formatter owns the caller-supplied 4-char prefix.
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
        <Show when={hitRateText()}>
          <text fg={hitRateColorMemo()}>{hitRateText()}</text>
        </Show>

        {/* Models sub-section */}
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => setOpenModels((x) => !x)}
        >
          <text fg={theme().textMuted}>
            {"  " + (openModels() ? "\u25bc " : "\u25b6 ") + "Models"}
          </text>
        </box>
        <Show when={openModels()}>
          <For each={view().modelRows.slice(0, MAX_VISIBLE_ROWS)}>
            {([key, totals]) => (
              <text fg={theme().textMuted}>
                {formatModelRow(key, totals, w())}
              </text>
            )}
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
          <text fg={theme().textMuted}>
            {"  " + (openAgents() ? "\u25bc " : "\u25b6 ") + "Agents"}
          </text>
        </box>
        <Show when={openAgents()}>
          <For
            each={view().agentRows.slice(0, MAX_VISIBLE_ROWS)}
          >
            {([agentName, totals]) => {
              const isExpanded = () =>
                expandedAgents().has(agentName)
              const sessions = () =>
                view().agentSessions.get(agentName) ?? []
              const sessionCount = () => sessions().length
              const expandable = () => sessionCount() > 1
              const childSlice = () =>
                sessions().slice(0, MAX_VISIBLE_ROWS)

              // Agent row prefix: 4 chars ("  ▼ " / "  ▶ " / "    ")
              const prefix = () =>
                expandable()
                  ? isExpanded()
                    ? "  \u25bc "
                    : "  \u25b6 "
                  : "    "

              return (
                <box>
                  {/* Agent row (clickable if expandable) */}
                  <box
                    flexDirection="row"
                    onMouseDown={() =>
                      expandable() && toggleAgent(agentName)
                    }
                  >
                    <text fg={theme().text}>
                      {formatAgentRow(
                        prefix(),
                        agentName,
                        totals.count,
                        totals,
                        w()
                      )}
                    </text>
                  </box>
                  {/* Child sessions */}
                  <Show when={isExpanded()}>
                    <For each={childSlice()}>
                      {(child) => {
                        const isCurrentSession = () =>
                          child.sessionID === props.sessionId()
                        return (
                          <text
                            fg={
                              isCurrentSession()
                                ? theme().text
                                : theme().textMuted
                            }
                          >
                            {formatChildRow(
                              sessionLabel(
                                sessionMeta,
                                child.sessionID,
                                props.sessionId()
                              ),
                              child.totals,
                              isCurrentSession(),
                              w()
                            )}
                          </text>
                        )
                      }}
                    </For>
                    <Show
                      when={
                        sessionCount() > MAX_VISIBLE_ROWS
                      }
                    >
                      <text fg={theme().textMuted}>
                        {"    +" +
                          (sessionCount() -
                            MAX_VISIBLE_ROWS) +
                          " more sessions"}
                      </text>
                    </Show>
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
