import { AGENT_KINDS } from "../core/types.js";
import type { AgentKind, SessionIndex } from "../core/types.js";
import type { ScanCache } from "./cache.js";
import { indexClaude } from "./indexers/claude.js";
import { indexCodex } from "./indexers/codex.js";
import { indexCursor } from "./indexers/cursor.js";
import { finalizeIndex } from "./store.js";

/** Scan local Claude / Codex / Cursor transcript trees into a SessionIndex. */

const indexers = {
  claude: (cache?: ScanCache) => indexClaude({ cache }),
  codex: (cache?: ScanCache) => indexCodex({ cache }),
  cursor: (cache?: ScanCache) => indexCursor({ cache }),
};

export const buildIndex = async (options?: {
  agents?: AgentKind[];
  /** Reuses unchanged files' results and is updated in place. Omit to rescan everything. */
  cache?: ScanCache;
}): Promise<SessionIndex> => {
  // Collect all agents
  const agents = new Set<AgentKind>(options?.agents ?? AGENT_KINDS);

  // Collect all sessions and links
  const sessions = [];
  const links = [];

  for (const agent of agents) {
    const r = await indexers[agent](options?.cache);
    sessions.push(...r.sessions);
    links.push(...r.links);
  }

  return finalizeIndex(sessions, links);
}
