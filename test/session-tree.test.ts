import { describe, test, expect } from "bun:test"
import {
  isDescendant,
  treeSessionIDs,
  type SessionNodeMeta,
} from "../src/session-tree.js"

function meta(entries: Record<string, SessionNodeMeta>): Map<string, SessionNodeMeta> {
  return new Map(Object.entries(entries))
}

describe("isDescendant", () => {
  const tree = meta({
    root: {},
    child: { parentID: "root" },
    grandchild: { parentID: "child" },
    other: {},
    stranger: { parentID: "other" },
  })

  test("a session is part of its own tree", () => {
    expect(isDescendant(tree, "root", "root")).toBe(true)
    expect(isDescendant(tree, "child", "child")).toBe(true)
  })

  test("follows direct children and deep grandchildren", () => {
    expect(isDescendant(tree, "child", "root")).toBe(true)
    expect(isDescendant(tree, "grandchild", "root")).toBe(true)
  })

  test("unrelated session is not in the tree", () => {
    expect(isDescendant(tree, "other", "root")).toBe(false)
    expect(isDescendant(tree, "stranger", "root")).toBe(false)
  })

  test("missing parent link is not in the tree", () => {
    expect(isDescendant(meta({ orphan: { parentID: "ghost" } }), "orphan", "root")).toBe(false)
  })

  test("empty parentID is not in the tree", () => {
    expect(isDescendant(meta({ orphan: { parentID: "" } }), "orphan", "root")).toBe(false)
  })

  test("a malformed parent cycle terminates and returns false", () => {
    const cyclic = meta({
      a: { parentID: "b" },
      b: { parentID: "a" },
    })
    expect(isDescendant(cyclic, "a", "root")).toBe(false)
  })

  test("deleted sessions are never descendants", () => {
    const withDeleted = meta({
      root: {},
      child: { parentID: "root", deleted: true },
      grandchild: { parentID: "child" },
    })
    expect(isDescendant(withDeleted, "child", "root")).toBe(false)
    // Ancestry itself is not broken by an intermediate deletion; only the
    // deleted node is excluded from the tree.
    expect(isDescendant(withDeleted, "grandchild", "root")).toBe(true)
  })

  test("MAX_DEPTH caps the walk: 64 hops resolve, 65 do not", () => {
    expect(isDescendant(chain(64), "s0", "root")).toBe(true)
    expect(isDescendant(chain(65), "s0", "root")).toBe(false)
  })
})

describe("treeSessionIDs", () => {
  test("returns root first, then breadth-first descendants", () => {
    const tree = meta({
      root: {},
      a: { parentID: "root" },
      b: { parentID: "root" },
      c: { parentID: "a" },
      d: { parentID: "b" },
    })
    expect(treeSessionIDs(tree, "root")).toEqual(["root", "a", "b", "c", "d"])
  })

  test("skips deleted sessions", () => {
    const tree = meta({
      root: {},
      a: { parentID: "root", deleted: true },
      b: { parentID: "root" },
      c: { parentID: "a" },
    })
    // `a` is skipped; `c` remains reachable through it (only the deleted node
    // itself is dropped, not its subtree).
    expect(treeSessionIDs(tree, "root")).toEqual(["root", "b", "c"])
  })

  test("returns [] for a deleted root", () => {
    const tree = meta({
      root: { deleted: true },
      a: { parentID: "root" },
    })
    expect(treeSessionIDs(tree, "root")).toEqual([])
  })

  test("returns [] for an unknown root", () => {
    expect(treeSessionIDs(meta({ a: {} }), "missing")).toEqual([])
  })

  test("does not attach nodes with missing or unknown parents", () => {
    const tree = meta({
      root: {},
      attached: { parentID: "root" },
      orphanUnknown: { parentID: "ghost" },
      orphanEmpty: { parentID: "" },
    })
    expect(treeSessionIDs(tree, "root")).toEqual(["root", "attached"])
  })

  test("a malformed parent cycle terminates without duplicates", () => {
    const cyclic = meta({
      root: {},
      a: { parentID: "root" },
      b: { parentID: "a" },
    })
    // Make `a` point back at `b` after the fact to simulate corruption.
    cyclic.get("a")!.parentID = "b"
    const ids = treeSessionIDs(cyclic, "root")
    expect(ids).toContain("root")
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/** s0 deepest, s{n-1} hangs off "root". */
function chain(n: number): Map<string, SessionNodeMeta> {
  const tree = new Map<string, SessionNodeMeta>([["root", {}]])
  for (let i = 0; i < n; i++) {
    tree.set(`s${i}`, { parentID: i === n - 1 ? "root" : `s${i + 1}` })
  }
  return tree
}
