/**
 * Build script for opencode-throughput.
 *
 * Solid JSX must be compiled by @opentui/solid's bundler plugin. A plain
 * `bun build` does NOT apply the Solid transform: it emits raw `jsxDEV(...)`
 * calls importing `@opentui/solid/jsx-dev-runtime` instead of the fine-grained
 * `createElement` / `createTextNode` / `setProp` / `insert` primitives. The
 * plugin is documented in node_modules/@opentui/solid/README.md ("To build use
 * Bun.build") and exported from the "./bun-plugin" subpath.
 */
import solidPlugin from "@opentui/solid/bun-plugin"
import { existsSync } from "node:fs"
import { relative } from "node:path"

const entrypoints = ["src/index.ts", "src/tui.tsx"]

/** Kept external so the opencode runtime supplies these at load time. */
const external = ["@opencode-ai/plugin", "@opentui/core", "@opentui/solid", "solid-js"]

const missing = entrypoints.filter((entry) => !existsSync(entry))
if (missing.length > 0) {
  console.error(`build: missing entrypoint(s): ${missing.join(", ")}`)
  process.exit(1)
}

// target "bun": the consumer is the opencode Bun runtime, and @opentui/solid
// documents target "bun" for its plugin. External imports are left untouched
// either way, so the server entry is equivalent to the old --target node build.
const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  target: "bun",
  plugins: [solidPlugin],
  external,
  throw: false,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  console.error(`build: failed with ${result.logs.length} error(s)`)
  process.exit(1)
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(2)} KiB`
console.log(`build: emitted ${result.outputs.length} file(s) to dist/`)
for (const output of result.outputs) {
  console.log(`  ${relative(process.cwd(), output.path)}  ${kib(output.size)}`)
}
