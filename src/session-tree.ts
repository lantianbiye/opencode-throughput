// Pure session-tree ancestry helpers for the TUI sidebar.
//
// OpenCode sessions form a parent/child forest via `parentID`; the TUI only has
// the flat metadata map it received from the server, so every question ("is this
// row in the active tree?", "in what order do I render the tree?") has to be
// answered by walking that map. Both helpers are defensive on purpose: a broken
// or partially-known chain is treated as "not in the tree" rather than guessed
// at, and malformed cycles can never hang the render loop.

export interface SessionNodeMeta {
  parentID?: string
  title?: string
  agent?: string
  deleted?: boolean
}

/** Second guard against malformed parent chains; see the cycle guard in `isDescendant`. */
const MAX_DEPTH = 64

/** True when `sessionID` is `rootID` itself or a descendant of it. */
export function isDescendant(
  meta: ReadonlyMap<string, SessionNodeMeta>,
  sessionID: string,
  rootID: string
): boolean {
  if (!sessionID || !rootID) return false
  // A session is always part of its own tree.
  if (sessionID === rootID) return true
  // A deleted session is never a descendant.
  if (meta.get(sessionID)?.deleted) return false

  // Walk up via parentID. A chain that cannot be proven to reach rootID is not
  // in the tree: an unknown or empty parent link, or an exhausted depth budget,
  // is a "no" rather than a guess.
  const seen = new Set<string>([sessionID])
  let current = sessionID
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const node = meta.get(current)
    if (!node) return false
    const parent = node.parentID
    // Missing / empty parentID: unproven chain, do not guess.
    if (!parent) return false
    // Missing from the metadata map: unproven chain, do not guess.
    if (!meta.has(parent)) return false
    if (parent === rootID) return true
    // Cycle guard: a malformed parentID loop must terminate, not spin.
    if (seen.has(parent)) return false
    seen.add(parent)
    current = parent
  }
  return false
}

/**
 * rootID first, then all descendants breadth-first, excluding deleted sessions.
 * Returns [] when the root is unknown or itself deleted.
 */
export function treeSessionIDs(
  meta: ReadonlyMap<string, SessionNodeMeta>,
  rootID: string
): string[] {
  if (!rootID) return []
  const root = meta.get(rootID)
  if (!root || root.deleted) return []

  // Index children by parent. A node whose parentID is missing or unknown is
  // not attached to anyone, so it can never leak into an unrelated tree.
  const children = new Map<string, string[]>()
  for (const [id, node] of meta) {
    const parent = node.parentID
    if (!parent || !meta.has(parent)) continue
    let siblings = children.get(parent)
    if (siblings === undefined) {
      siblings = []
      children.set(parent, siblings)
    }
    siblings.push(id)
  }

  const result: string[] = []
  const seen = new Set<string>()
  const queue: string[] = [rootID]
  while (queue.length > 0) {
    const id = queue.shift() as string
    // Cycle safety: a malformed parentID loop must not emit a session twice.
    if (seen.has(id)) continue
    seen.add(id)
    const node = meta.get(id)
    if (!node) continue
    if (!node.deleted) result.push(id)
    const kids = children.get(id)
    if (kids) {
      for (const child of kids) {
        if (!seen.has(child)) queue.push(child)
      }
    }
  }
  return result
}
