import type { AgentKind, SessionIndex } from "../core/types.js";
import { indexClaude } from "./indexers/claude.js";
import { indexCodex } from "./indexers/codex.js";
import { indexCursor } from "./indexers/cursor.js";
import { finalizeIndex } from "./store.js";

/** Scan local Claude / Codex / Cursor transcript trees into a SessionIndex. */
export async function buildIndex(options?: {
  agents?: AgentKind[];
}): Promise<SessionIndex> {
  const agents = new Set<AgentKind>(
    options?.agents ?? ["claude", "codex", "cursor"],
  );

  const sessions = [];
  const links = [];

  if (agents.has("claude")) {
    const r = await indexClaude();
    sessions.push(...r.sessions);
    links.push(...r.links);
  }
  if (agents.has("codex")) {
    const r = await indexCodex();
    sessions.push(...r.sessions);
    links.push(...r.links);
  }
  if (agents.has("cursor")) {
    const r = await indexCursor();
    sessions.push(...r.sessions);
    links.push(...r.links);
  }

  return finalizeIndex(sessions, links);
}
