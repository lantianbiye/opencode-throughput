# AGENTS.md

OpenCode plugin `opencode-throughput`: real-time LLM metrics (TTFT, TPS, latency, tokens, cost).
Bun + TypeScript, no framework. Two independent halves that OpenCode loads from two different config files.

## Commands

- `bun install` — Bun, not npm. `bun.lock` is present but gitignored.
- `bun test` — all tests (106 tests, 5 files). There is **no** `test` npm script.
- `bun test test/throughput.test.ts` — single file.
- `bun run typecheck` — `tsc --noEmit`. Only covers `src/**`; `test/` and `scripts/` are **not** typechecked.
- `bun run build` — the real build. **Do not** run `bun build src/tui.tsx` directly (see below).
- No linter or formatter is configured (no eslint/prettier/biome). Match existing style.
- Ignore editor LSP errors in `test/` and `scripts/` (`bun:test`, `Bun`): `@types/bun` is not a
  dependency. Those dirs are outside `tsconfig.json` on purpose; `bun test` and `bun run build` work.

## Build gotcha (most likely thing to get wrong)

`bun run build` runs `scripts/build.ts`, which is required for the TUI half: a plain `bun build` does
**not** apply the Solid transform and emits raw `jsxDEV(...)` instead of fine-grained `@opentui/solid`
primitives. The build script loads `@opentui/solid/bun-plugin` and keeps these peers external:
`@opencode-ai/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js`.

The `build:server` script (`bun build src/index.ts --target node`) builds only the server half and
skips the TUI. Prefer `bun run build`.

## Two entrypoints

- **Server half** — `src/index.ts`, also `main` and `exports["."]`, exposed as raw TS (`./src/index.ts`);
  OpenCode loads the source, so no build is needed for it.
- **TUI half** — `src/tui.tsx`, published as `dist/tui.js` via `exports["./tui"]`. Only reachable after a
  build; the TUI runtime never falls back to `main`. A single module may not export both halves.
- Build/config edits must keep the `exports` map, `files`, and external list consistent.

## Conventions

- ESM with `.js` extensions on relative imports even though sources are `.ts`/`.tsx`
  (bundler moduleResolution), e.g. `import { cacheHitRate } from "./cache-rate.js"`.
- TUI JSX uses `@opentui/solid` (`jsxImportSource` in `tsconfig.json`); the TUI entrypoint declares
  `/** @jsxImportSource @opentui/solid */`.
- `src/cache-rate.ts`, `src/group-stats.ts`, `src/row-format.ts` and `src/session-tree.ts` are pure,
  dependency-free logic modules with their own unit tests — keep them that way. `src/tui.tsx` keeps its
  own copies of the small formatters instead of importing from a `.tsx` component.
  The TUI deliberately re-declares its local types rather than importing `src/types.ts`.

## Testing gotchas

- Tests must **never** read, write, or unlink the real `~/.opencode/throughput.jsonl`. The plugin resolves
  its log path lazily from `OPENCODE_THROUGHPUT_LOG`, and every test points that at a temp file. Do not
  reintroduce `os.homedir()` or a backup/unlink of the real log.
- Coverage is limited to the server plugin and the pure modules (`cache-rate`, `group-stats`, `row-format`,
  `session-tree`); `src/tui.tsx` itself has no tests.

## Metric semantics — intentional, do not "simplify"

- **TTFT** = message `time.created` → first `text`/`reasoning` part carrying a finite `time.start`.
  No `Date.now()` fallback; steps that generate nothing report `null`.
- **TPS** = `(outputTokens + reasoningTokens) / (genStart → genEnd)` where `genEnd` is the earliest tool
  execution start, so **tool runtime is excluded**. `latency_ms` stays end-to-end.
- **Cache hit rate** = `cacheRead / (cacheRead + input + cacheWrite)`. `tokens.input` is the *non-cached*
  prompt share, so `cacheRead > input` is normal. A cache write counts as a miss.
- `src/plugins/throughput.ts` (server) and `src/tui.tsx` (TUI) duplicate this logic on purpose — they run
  in separate processes with separate state.

## CI / release

- `.github/workflows/ci.yml`: typecheck + build on push/PR to `main`.
- `.github/workflows/release.yml`: publishes to npm **only** on manual `workflow_dispatch`, and only when
  `package.json` version changed and tag `v<version>` does not yet exist. To release: bump the version,
  get it onto `main`, then run the workflow. `prepublishOnly` runs `bun run build` automatically.

## Dogfooding

`.opencode/plugins/throughput.ts` re-exports `src/plugins/throughput.js`, so this repo loads the plugin
itself. `.opencode/package.json`, its lockfile/node_modules, and `.opencode/*.md` (the generated
`throughput.md`) are gitignored and generated locally — do not commit them.

## Reference

`README.md` is unusually detailed on metric provenance, provider differences, and how to cross-check
results against OpenCode's own `~/.local/share/opencode/opencode.db`. Read the relevant section before
changing any metric.
