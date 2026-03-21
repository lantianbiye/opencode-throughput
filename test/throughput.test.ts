import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { LogEntry } from "../src/types.js"

const TEST_DIR = path.join(os.tmpdir(), "opencode-throughput-test-" + process.pid)
const REAL_LOG_DIR = path.join(os.homedir(), ".opencode")
const REAL_LOG_FILE = path.join(REAL_LOG_DIR, "throughput.jsonl")

const logCalls: Array<{ service: string; level: string; message: string; extra: any }> = []
let baseLogCount = 0

const mockClient = {
  app: {
    log: async (opts: any) => {
      logCalls.push(opts.body)
      return true
    },
  },
}

function getLogContent(): LogEntry[] {
  if (!fs.existsSync(REAL_LOG_FILE)) return []
  return fs
    .readFileSync(REAL_LOG_FILE, "utf-8")
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l) as LogEntry)
}

function removeLastLineFromLog() {
  if (!fs.existsSync(REAL_LOG_FILE)) return
  const content = fs.readFileSync(REAL_LOG_FILE, "utf-8")
  const lines = content.split("\n").filter((l: string) => l.trim())
  if (lines.length === 0) {
    fs.unlinkSync(REAL_LOG_FILE)
  } else {
    lines.pop()
    fs.writeFileSync(REAL_LOG_FILE, lines.join("\n") + "\n", "utf-8")
  }
}

function makeAssistantMessage(overrides: Record<string, any> = {}) {
  return {
    id: "msg-1",
    sessionID: "sess-1",
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
    time: { created: Date.now() - 5000, completed: Date.now() },
    tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 200, write: 100 } },
    cost: 0.01,
    finish: "stop",
    ...overrides,
  }
}

async function createPlugin() {
  const { ThroughputPlugin } = await import("../src/plugins/throughput.js")
  const hooks = await ThroughputPlugin({ client: mockClient } as any)
  return hooks
}

function snapshotNewEntries(): LogEntry[] {
  const all = getLogContent()
  return all.slice(baseLogCount)
}

function cleanupNewEntries() {
  const all = getLogContent()
  const toRemove = all.length - baseLogCount
  for (let i = 0; i < toRemove; i++) {
    removeLastLineFromLog()
  }
}

beforeEach(() => {
  logCalls.length = 0
  baseLogCount = getLogContent().length
})

afterEach(() => {
  cleanupNewEntries()
})

describe("event handling: complete flow", () => {
  test("part.updated -> message.updated: TTFT, TPS, latency, tokens, cost all recorded", async () => {
    const hooks = await createPlugin()
    const createdTime = Date.now() - 5000
    const completedTime = Date.now()
    const partStartTime = createdTime + 2000

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "msg-1",
            time: { start: partStartTime },
          },
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: createdTime, completed: completedTime },
          }),
        },
      } as any,
    })

    expect(logCalls.length).toBe(1)
    expect(logCalls[0].service).toBe("opencode-throughput")
    expect(logCalls[0].level).toBe("info")
    expect(logCalls[0].message).toContain("claude-sonnet-4")
    expect(logCalls[0].message).toContain("TTFT")
    expect(logCalls[0].message).toContain("tok/s")
    expect(logCalls[0].extra.ttft_ms).toBe(2000)
    expect(logCalls[0].extra.tps).toBeGreaterThan(0)
    expect(logCalls[0].extra.latency_ms).toBe(5000)
    expect(logCalls[0].extra.inputTokens).toBe(1000)
    expect(logCalls[0].extra.outputTokens).toBe(500)
    expect(logCalls[0].extra.cost).toBe(0.01)

    const logs = snapshotNewEntries()
    expect(logs.length).toBe(1)
    expect(logs[0].ttft_ms).toBe(2000)
    expect(logs[0].latency_ms).toBe(5000)
    expect(logs[0].tps).toBeGreaterThan(0)
    expect(logs[0].model).toBe("anthropic/claude-sonnet-4")
    expect(logs[0].inputTokens).toBe(1000)
    expect(logs[0].outputTokens).toBe(500)
    expect(logs[0].reasoningTokens).toBe(0)
    expect(logs[0].cacheReadTokens).toBe(200)
    expect(logs[0].cacheWriteTokens).toBe(100)
    expect(logs[0].cost).toBe(0.01)
    expect(logs[0].finish).toBe("stop")
    expect(logs[0].sessionID).toBe("sess-1")
  })

  test("no TTFT when message.part.updated is missing", async () => {
    const hooks = await createPlugin()
    const createdTime = Date.now() - 5000

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: createdTime, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.ttft_ms).toBeNull()
    const logs = snapshotNewEntries()
    expect(logs[0].ttft_ms).toBeNull()
  })

  test("no TTFT when part is not text type", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool_use",
            messageID: "msg-1",
            time: { start: Date.now() - 3000 },
          },
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.ttft_ms).toBeNull()
  })

  test("no TTFT when part has no time.start", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "msg-1",
          },
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.ttft_ms).toBeNull()
  })
})

describe("edge cases", () => {
  test("message without time.created AND time.completed: skip entirely", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls.length).toBe(0)
    expect(snapshotNewEntries().length).toBe(0)
  })

  test("message without time.completed: no trigger", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls.length).toBe(0)
  })

  test("user role messages are ignored", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "user",
            id: "msg-1",
            time: { created: Date.now() - 5000, completed: Date.now() },
          },
        },
      } as any,
    })

    expect(logCalls.length).toBe(0)
  })

  test("error finish sets warn level", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            finish: "error",
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].level).toBe("warn")
  })

  test("zero output tokens: TPS is null", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.tps).toBeNull()
  })

  test("missing tokens field: defaults to 0", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            tokens: undefined,
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.inputTokens).toBe(0)
    expect(logCalls[0].extra.outputTokens).toBe(0)
    const logs = snapshotNewEntries()
    expect(logs[0].inputTokens).toBe(0)
  })

  test("missing providerID/modelID: defaults to empty string", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            providerID: undefined,
            modelID: undefined,
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.model).toBe("/")
    const logs = snapshotNewEntries()
    expect(logs[0].model).toBe("/")
  })

  test("message.removed cleans up pending TTFT tracking", async () => {
    const hooks = await createPlugin()
    const createdTime = Date.now() - 5000

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "msg-1",
            time: { start: createdTime + 2000 },
          },
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.removed",
        properties: { messageID: "msg-1" },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            id: "msg-1",
            time: { created: createdTime, completed: Date.now() },
          }),
        },
      } as any,
    })

    expect(logCalls[0].extra.ttft_ms).toBeNull()
  })

  test("message.part.updated without part property: no crash", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {},
      } as any,
    })

    expect(logCalls.length).toBe(0)
  })

  test("message.updated without properties.info: no crash", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {},
      } as any,
    })

    expect(logCalls.length).toBe(0)
  })
})

describe("multi-message aggregation", () => {
  test("two messages from same model accumulate in log", async () => {
    const hooks = await createPlugin()

    for (let i = 0; i < 2; i++) {
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: makeAssistantMessage({
              id: `msg-${i}`,
              time: { created: Date.now() - 5000, completed: Date.now() },
              cost: 0.01,
            }),
          },
        } as any,
      })
    }

    expect(logCalls.length).toBe(2)
    expect(snapshotNewEntries().length).toBe(2)
    const totalCost = snapshotNewEntries().reduce((s, l) => s + l.cost, 0)
    expect(totalCost).toBeCloseTo(0.02, 5)
  })

  test("messages from different models both logged", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            id: "msg-1",
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            id: "msg-2",
            providerID: "openai",
            modelID: "gpt-5",
            cost: 0.02,
            time: { created: Date.now() - 3000, completed: Date.now() },
          }),
        },
      } as any,
    })

    const logs = snapshotNewEntries()
    expect(logs.length).toBe(2)
    expect(logs[0].model).toBe("anthropic/claude-sonnet-4")
    expect(logs[1].model).toBe("openai/gpt-5")
  })
})

describe("log message format", () => {
  test("contains model name, TTFT, TPS, latency, token counts", async () => {
    const hooks = await createPlugin()

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: makeAssistantMessage({
            time: { created: Date.now() - 5000, completed: Date.now() },
          }),
        },
      } as any,
    })

    const msg = logCalls[0].message
    expect(msg).toContain("claude-sonnet-4")
    expect(msg).toContain("TTFT")
    expect(msg).toContain("tok/s")
    expect(msg).toContain("\u2191")
    expect(msg).toContain("\u2193")
  })
})

describe("benchmark tool", () => {
  let backupContent: string | null = null
  const LOG_FILE = path.join(os.homedir(), ".opencode", "throughput.jsonl")

  beforeEach(() => {
    if (fs.existsSync(LOG_FILE)) {
      backupContent = fs.readFileSync(LOG_FILE, "utf-8")
      fs.unlinkSync(LOG_FILE)
    }
  })

  afterEach(() => {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE)
    if (backupContent !== null) {
      fs.writeFileSync(LOG_FILE, backupContent, "utf-8")
      backupContent = null
    }
  })

  async function createPluginWithBenchmark() {
    const { ThroughputPlugin } = await import("../src/plugins/throughput.js")
    const hooks = await ThroughputPlugin({ client: mockClient } as any)
    return hooks
  }

  function writeTestLogs(entries: LogEntry[]) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
    fs.writeFileSync(LOG_FILE, lines, "utf-8")
  }

  test("no data: returns helpful message", async () => {
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({}, {} as any)
    expect(result).toContain("No benchmark data yet")
  })

  test("single entry: shows model stats", async () => {
    writeTestLogs([
      {
        ts: "2026-03-21T10:00:00Z",
        model: "anthropic/claude-sonnet-4",
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        sessionID: "s1",
        messageID: "m1",
        ttft_ms: 2000,
        tps: 50,
        latency_ms: 5000,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        cost: 0.01,
        finish: "stop",
      },
    ])
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({}, {} as any) as string
    expect(result).toContain("anthropic/claude-sonnet-4")
    expect(result).toContain("Requests: 1")
    expect(result).toContain("2.0s")
    expect(result).toContain("50")
    expect(result).toContain("$0.0100")
    expect(result).toContain("Cache R/W")
  })

  test("filter by model name", async () => {
    writeTestLogs([
      {
        ts: "2026-03-21T10:00:00Z",
        model: "anthropic/claude-sonnet-4",
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        sessionID: "s1",
        messageID: "m1",
        ttft_ms: 2000, tps: 50, latency_ms: 5000,
        inputTokens: 1000, outputTokens: 500, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, finish: "stop",
      },
      {
        ts: "2026-03-21T10:01:00Z",
        model: "openai/gpt-5",
        providerID: "openai",
        modelID: "gpt-5",
        sessionID: "s1",
        messageID: "m2",
        ttft_ms: 500, tps: 100, latency_ms: 3000,
        inputTokens: 800, outputTokens: 300, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02, finish: "stop",
      },
    ])
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({ model: "gpt" }, {} as any) as string
    expect(result).toContain("openai/gpt-5")
    expect(result).not.toContain("claude-sonnet-4")
  })

  test("case-insensitive filter", async () => {
    writeTestLogs([
      {
        ts: "2026-03-21T10:00:00Z",
        model: "anthropic/claude-sonnet-4",
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        sessionID: "s1",
        messageID: "m1",
        ttft_ms: 2000, tps: 50, latency_ms: 5000,
        inputTokens: 1000, outputTokens: 500, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, finish: "stop",
      },
    ])
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({ model: "CLAUDE" }, {} as any) as string
    expect(result).toContain("claude-sonnet-4")
  })

  test("last parameter limits entries", async () => {
    writeTestLogs([
      {
        ts: "2026-03-21T10:00:00Z", model: "a/b", providerID: "a", modelID: "b",
        sessionID: "s1", messageID: "m1",
        ttft_ms: 1000, tps: 10, latency_ms: 1000,
        inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.001, finish: "stop",
      },
      {
        ts: "2026-03-21T10:01:00Z", model: "a/b", providerID: "a", modelID: "b",
        sessionID: "s1", messageID: "m2",
        ttft_ms: 2000, tps: 20, latency_ms: 2000,
        inputTokens: 200, outputTokens: 100, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.002, finish: "stop",
      },
    ])
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({ last: 1 }, {} as any) as string
    expect(result).toContain("Total requests: 1")
  })

  test("aggregation across multiple entries", async () => {
    writeTestLogs([
      {
        ts: "2026-03-21T10:00:00Z", model: "a/b", providerID: "a", modelID: "b",
        sessionID: "s1", messageID: "m1",
        ttft_ms: 2000, tps: 50, latency_ms: 5000,
        inputTokens: 1000, outputTokens: 500, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, finish: "stop",
      },
      {
        ts: "2026-03-21T10:01:00Z", model: "a/b", providerID: "a", modelID: "b",
        sessionID: "s1", messageID: "m2",
        ttft_ms: 4000, tps: 100, latency_ms: 8000,
        inputTokens: 2000, outputTokens: 1000, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02, finish: "stop",
      },
    ])
    const hooks = await createPluginWithBenchmark()
    const result = await hooks.tool!.benchmark.execute({}, {} as any) as string
    expect(result).toContain("Total requests: 2")
    expect(result).toContain("avg 3.0s")
    expect(result).toContain("min 2.0s")
    expect(result).toContain("max 4.0s")
    expect(result).toContain("$0.0300")
  })
})
