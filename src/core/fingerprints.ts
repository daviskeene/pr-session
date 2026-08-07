import type { AgentKind } from "./types.js";

/** Soft agent fingerprints commonly left in PR bodies. */
export function detectAgentFingerprints(text: string): AgentKind[] {
  const found = new Set<AgentKind>();
  if (
    /Generated with \[Claude Code\]/i.test(text) ||
    /claude\.com\/claude-code/i.test(text)
  ) {
    found.add("claude");
  }
  if (/Made with \[Cursor\]/i.test(text) || /CURSOR_AGENT_PR_BODY/i.test(text)) {
    found.add("cursor");
  }
  if (/OpenAI Codex/i.test(text) || /generated.*codex/i.test(text)) {
    found.add("codex");
  }
  return [...found];
}
