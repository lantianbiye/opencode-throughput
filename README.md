# opencode-throughput

Real-time LLM performance monitoring plugin for [OpenCode](https://opencode.ai). Tracks latency, throughput, token usage, prompt-cache hit rate, and cost per model, with toast notifications, a live sidebar panel, and JSONL logging.

## Features

- **TTFT** — time to the first generated token, text or reasoning
- **TPS** (Tokens Per Second) — generated-token throughput: reasoning included, tool runtime excluded
- **Total Latency** — end-to-end request time
- **Token Usage** — input, output, reasoning, cache read/write (all provider-reported)
- **Cache Hit Rate** — cached prompt tokens over total prompt tokens, per session
- **Cost Tracking** — per-request and cumulative cost
- **Toast Notifications** — real-time performance summary after each LLM response
- **TUI Panel** — live per-session stats in the sidebar, with the cache hit rate
- **JSONL Logging** — persistent logs at `~/.opencode/throughput.jsonl`
- **Project Report** — appends a one-line summary per request to `<project>/.opencode/throughput.md`
- **Benchmark Tool** — query historical stats on demand from the AI agent

TTFT and TPS are generation-time metrics: their window opens at the first `text`/`reasoning` part
carrying a timestamp and closes when the first tool starts executing, so tool runtime is excluded
from TPS while `latency_ms` keeps it. See
[Metric Provenance & Reliability](#metric-provenance--reliability).

## Installation

The package ships two entrypoints that OpenCode loads from two different config files:

| Half | Config file | Adds |
| --- | --- | --- |
| Server plugin | `opencode.json` | toast notifications, JSONL log, project report, `benchmark` tool |
| TUI plugin | `tui.json` | the live sidebar panel |

`opencode.json` (project, or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-throughput"]
}
```

`tui.json` (project, or `~/.config/opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-throughput"]
}
```

The two halves are independent: `opencode.json` alone gives you toasts, logs and the `benchmark`
tool; `tui.json` alone gives you the sidebar panel. The `opencode plugin <package>` CLI writes both
files in one call.

For npm specs OpenCode resolves the TUI half from the package `exports["./tui"]` entrypoint (here
`dist/tui.js`) and never falls back to `main`, and a single module may not export both halves at
once. `.jsonc` config filenames are accepted as well.

## Usage

Once installed, the plugin runs automatically:

1. **After each LLM response**, a toast notification appears with metrics:

   ```
   claude-sonnet-4 | 2.1s TTFT | 58.3 tok/s | 4.2s | ↑1.2k ↓892
   ```

   The same summary is also sent to OpenCode's own log via `client.app.log`.

2. **JSONL logs** are appended to `~/.opencode/throughput.jsonl` (one JSON object per line)

3. **A one-line summary per request** is appended to `<project>/.opencode/throughput.md`

4. **The sidebar panel** tracks the active session's totals and cache hit rate — see [TUI Panel](#tui-panel)

5. **Query benchmarks** — ask the AI agent to use the `benchmark` tool:

   > "Show me the benchmark stats for claude"
   > "Compare model performance"
   > "Show the last 10 requests"

## TUI Panel

The TUI half registers a `Throughput` widget into the `sidebar_content` slot:

```
▼ Throughput 42 reqs $0.1832
  Cache 83.2% 1.2M/1.4M
  ▼ Models
  │▶ dsf-v4.1   3.1s 233tk/s $0.1832
  │▶ mimo-v2.5  2.1s 36tk/s $0.0016
  ▼ Agents
  │▶ orchestrator 42r 233tk/s $0.1832
  │▶ explorer     3r 118tk/s $0.0091
```

- **Header** — request count and accumulated cost for the session; clicking it collapses or
  expands the body (expanded by default).
- **Cache line** — cached prompt tokens over total prompt tokens; the percentage is colored by hit
   rate: green at 70%+, default text at 40–69%, red only at 0% with multiple requests (a single
   request with 0% is normal and stays muted).
- **Models** — collapsible section (open by default), one row per model, highest cost first.  Each
   model row is itself collapsible (click to toggle, collapsed by default): line 1 shows the fixed
   10-column name, average TTFT, token speed, and cost; expanding adds a line with the request count
   (`42r`), token totals (↑input, ↓output, ↓reasoning) and cache hit rate.
- **Agents** — collapsible section (open by default), one row per agent, highest cost first.  Agent
   names are padded to a fixed column so counts and speeds line up.  Line 1 shows the name, request
   count (`42r`), token speed and cost; expanding adds token totals and hit rate.
- **Colors** — the Models/Agents section labels use the default text color; their child rows are
   muted grey, except the token speed which is green at ≥ 80 tk/s, yellow at ≥ 30 tk/s, and red
   below 30 tk/s.
- **Model names** — the model name column is always exactly 10 display columns (padded with spaces)
   so rows line up.  Names longer than 10 columns are abbreviated to `<brand><variant>-<version>`,
   for example `deepseek-v4.1-flash` → `dsf-v4.1` and `glm-5.3-flash` → `glmf-5.3`.  The common
   models on the OpenCode Go plan have an explicit mapping; anything else is abbreviated by a
   deterministic fallback, and a name that cannot be abbreviated is clipped to 10 columns.
- **Narrow sidebars** — each row is an ordered set of fields and the least important ones are
   dropped whole as the pane narrows.  Token fields (↑in ↓out ↓r) move together rather than being
   dropped.  At extreme narrow widths (< 24 cols) the panel collapses to a single minimal line per
   row (speed + cost only).  Token speed and cost are never dropped.
- **Row cap** — the five costliest models and agents are shown, with a `+N more` line after each.
- **State** — per session and in memory inside the TUI process. When a session is first displayed
  it is seeded from the SDK session history, and every finished assistant message is deduped by
  `messageID`, so reopening an old session repopulates its totals instead of double counting.

Enable it through `tui.json` — see [Installation](#installation).

## Benchmark Tool Args

| Arg | Type | Description |
|-----|------|-------------|
| `model` | string (optional) | Filter by model name (partial match) |
| `last` | number (optional) | Only show the last N entries |

## Log Format

Set `OPENCODE_THROUGHPUT_LOG` to a file path to redirect the log. The `benchmark` tool reads the
same path, and the test suite uses the variable to stay away from your real log.

Each line in `~/.opencode/throughput.jsonl`:

```json
{
  "ts": "2026-03-21T10:00:00.000Z",
  "model": "anthropic/claude-sonnet-4",
  "providerID": "anthropic",
  "modelID": "claude-sonnet-4",
  "sessionID": "abc123",
  "messageID": "def456",
  "ttft_ms": 2100,
  "tps": 58.3,
  "latency_ms": 4200,
  "inputTokens": 1200,
  "outputTokens": 892,
  "reasoningTokens": 0,
  "cacheReadTokens": 500,
  "cacheWriteTokens": 200,
  "cost": 0.0234,
  "finish": "stop"
}
```

`tps` counts `outputTokens + reasoningTokens` over the generation window, while `outputTokens`
alone is only the visible text. `latency_ms` is end-to-end, tool runtime included.

## How It Works

The server plugin (`src/plugins/throughput.ts`) hooks into OpenCode's event system:

- `message.part.updated` — records the first part timestamp per message, which is what TTFT is
  measured from
- `message.updated` — when an assistant message reports `time.completed`, reads
  `tokens` + `cost`, computes TTFT, total latency and TPS, then emits the toast, the `app.log`
  entry, the JSONL line, and the `<project>/.opencode/throughput.md` line
- `message.removed`, `session.error` — clears per-message timing state

The `benchmark` tool does not use live state: it re-reads `~/.opencode/throughput.jsonl` on
every call, so it reports history across restarts.

The TUI plugin (`src/tui.tsx`) is a separate entry point that subscribes to the same events
inside the TUI process, keeps per-session state, seeds it from the SDK when a session is first
displayed, and renders a Solid component into a sidebar slot.

## Metric Provenance & Reliability

### Where each number comes from

| Field | Origin | Notes |
| --- | --- | --- |
| `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` | **Provider-reported usage** returned by the LLM API, normalized by OpenCode (`Session.getUsage`) | Never locally tokenized. OpenCode's only local estimator (`estimate = round(chars / 4)`, `packages/core/src/util/token.ts`) is used solely for context compaction and tool-output pruning, and never reaches message tokens. |
| `cost` | **Computed locally by OpenCode** from its model price catalogue (`https://models.opencode.ai/api.json`, 5-minute cache TTL, hourly refresh, falling back to a disk or build-time snapshot) | Reasoning tokens are billed at the output rate. On subscription plans (e.g. OpenCode Go) this is a quota-metered value, not money charged per token. |
| `ttft_ms`, `latency_ms` | **Measured locally** from wall-clock timestamps | `ttft_ms` = message creation → first generated token. `latency_ms` is end-to-end and includes tool runtime. Both include queueing and network time. |
| `tps` | **Derived locally** as `(outputTokens + reasoningTokens) / (genEnd − genStart)` | `genStart` = first `text`/`reasoning` part carrying a `time.start`; `genEnd` = first tool execution start, otherwise `time.completed`. `null` when nothing was generated. |
| Session totals in the TUI panel | Local accumulation over messages | Reproduces OpenCode's own `session` table totals exactly. |

OpenCode guarantees these buckets are non-overlapping (v1.4.0+, AI SDK v6):

```
total = input + cache.read + cache.write + output + reasoning
```

`tokens.input` is the **non-cached** share of the prompt, so `cacheRead > input` is normal, and
`cacheRead / (cacheRead + input + cacheWrite)` is the true cached-input-to-total-input ratio.

### Reading the metrics: caveats

1. **TTFT is measured to the first generated token, text or reasoning.** Message creation → first
   `text`/`reasoning` part carrying a `time.start`, so it includes queueing and provider latency,
   and on reasoning models it lands on the first thinking token rather than the first visible
   word. `step-start`, `step-finish`, `tool` and `patch` parts carry no `time.start` and are
   ignored — there is deliberately no `Date.now()` fallback.
2. **TPS counts reasoning and excludes tool runtime.** `genEnd` is the moment the first tool
   starts executing (falling back to `time.completed` when no tool ran), so a long `bash` or
   `task` call no longer dilutes the rate. Reasoning is included because it is real generated
   work — over half of all generated tokens in one measured sample — and because it is replayed
   into the next request as input. `latency_ms` stays end-to-end, tool runtime included.
3. **Steps that generated nothing report `null` rather than a guess.** A tool-call step with no
   `text` or `reasoning` part has `ttft_ms` and `tps` both `null`; the plugin no longer falls back
   to whole-latency throughput.
4. **Reasoning is reported inconsistently across providers.** DeepSeek/MiMo/OpenAI-class APIs
   report reasoning separately; Anthropic does not split thinking out of output, so `reasoning`
   is `0` and `output` carries it. Same column, different meaning per provider.
5. **Missing usage is silent.** If a gateway omits the streamed usage block (or `includeUsage` is
   disabled), OpenCode stores all-zero tokens, an undefined `total`, and `$0` cost with no
   warning, and such a row is indistinguishable from a very small request. In 115 real
   OpenCode Go requests none were observed (`total` was present on 101/101 messages), but a
   log row with every token bucket at `0` is worth suspecting.
6. **`Math.max(0, …)` clamping** in OpenCode's usage mapping can hide a provider that reports
   `cached > prompt`; the symptom is `input = 0` alongside a large `cacheRead`.
7. **Version drift.** The `input = total − cache.read − cache.write` normalization exists only
   from OpenCode v1.4.0 onward. On older builds paired with AI SDK v5, `tokens.input` may
   already be provider-inclusive, which would understate the cache hit rate. An undefined
   `total` combined with `cacheRead > 0` is the tell-tale.
8. **`cost` can be stale or wrong** when the price catalogue cannot be refreshed (offline or
   baked snapshot), while the token counts stay correct.
9. **Averages are arithmetic means over requests**, not token-weighted.

### Is reasoning billed again on the next request?

Mostly yes, which is the other reason `tps` includes it. OpenCode replays `reasoning` parts when
it assembles the next request: it keeps provider metadata (thinking signatures) for the same
model, downgrades reasoning to plain text when the model changed, and for DeepSeek-style
OpenAI-compatible providers moves the text into the `reasoning_content` message field. Whether
those replayed tokens are then charged as input is provider-dependent:

| Provider | Replayed by OpenCode | Counted as input next turn |
| --- | --- | --- |
| Anthropic "keep all" models (Opus 4.5+, Sonnet 4.6+) | thinking blocks, signatures preserved | Yes, and they join the cached prefix |
| Anthropic earlier models / Haiku ≤ 4.5 | thinking blocks (must be echoed inside a tool turn or the API returns 400) | No, the API strips older thinking |
| OpenAI reasoning models | reasoning items | No, discarded across turns (only same-turn function-call round trips need them) |
| Gemini | `thoughtSignature` parts | Documented as retained server-side from 3.5 Flash+; billing not documented |
| DeepSeek | `reasoning_content` field | Without `tools` it is ignored; with `tools` it must be echoed (400 otherwise) and is concatenated into context |
| OpenRouter | `reasoning` / `reasoning_details` | Yes, treated as part of the assistant message |

Measured on real OpenCode Go traffic (`deepseek-v4.1-flash`, `mimo-v2.5`): regressing each
request's prompt growth against the previous turn's replayed content gives a reasoning coefficient
of **0.92 ± 0.07** (t = 13) and halves the residual sum of squares, i.e. near-total replay.

Two practical consequences:

- On routes that replay reasoning, a large thinking block keeps feeding the cached prefix, so both
  `cacheRead` and the input side of the next request grow even when nothing else changed. A high
  hit rate does not mean the prompt is small.
- Compaction, tool-output pruning and model switches are where history stops being replayed, so
  "everything from the last turn reappears in the next prompt" does not hold across a compacted
  session.

### Cross-checking against OpenCode

OpenCode persists the same values in its own database, so this plugin's log can be validated
independently of the plugin:

```
~/.local/share/opencode/opencode.db  →  table `session`:
  cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
```

Summing `~/.opencode/throughput.jsonl` per `sessionID` reproduces those columns exactly
(verified over three sessions, all six fields), and `cost` recomputes from published
per-model prices — for example, for `deepseek-v4.1-flash`:

```
input × 0.15/M + cacheRead × 0.003/M + (output + reasoning) × 0.60/M
```

## Development

### Local development

Server half — point `opencode.json` at the source entry:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-throughput/src/index.ts"]
}
```

TUI half — this one is resolved through the package `exports["./tui"]` map, which points at the
built `dist/tui.js`. Either build first and reference that file, or import the TSX entry directly
(path plugins are imported as-is, so no build is needed):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-throughput/dist/tui.js"]
}
```

Put it in `tui.json`, not `opencode.json` — the TUI runtime only reads TUI plugin entries from
there.

### Build

```bash
bun install
bun run build
```

### Publish

```bash
npm publish --access public
```

## License

MIT
