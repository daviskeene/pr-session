import { AGENT_KINDS } from "./types.js";
import type { AgentKind, StampBlock, StampInput } from "./types.js";

const STAMP_TOKEN_SOURCE = `agent-session:\\/\\/(${AGENT_KINDS.join("|")})\\/([A-Za-z0-9._:-]+)`;

export function agentLabel(agent: AgentKind): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

/** Stamp token embedded in PR bodies / commit messages for exact reverse lookup. */
export function stampToken(agent: AgentKind, sessionId: string): string {
  return `agent-session://${agent}/${sessionId}`;
}

export function parseStampToken(
  text: string,
): { agent: AgentKind; sessionId: string } | null {
  const m = text.match(new RegExp(STAMP_TOKEN_SOURCE));
  if (!m) return null;
  return { agent: m[1] as AgentKind, sessionId: m[2] };
}

export function extractStampTokens(
  text: string,
): Array<{ agent: AgentKind; sessionId: string }> {
  const out: Array<{ agent: AgentKind; sessionId: string }> = [];
  const re = new RegExp(STAMP_TOKEN_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ agent: m[1] as AgentKind, sessionId: m[2] });
  }
  return out;
}

const STAMP_TRAILER_SOURCE = `^Agent-Session:\\s*(${AGENT_KINDS.join("|")})\\/([A-Za-z0-9._:-]+)\\s*$`;

/** Parse `Agent-Session: <agent>/<id>` git trailers (the ones buildStamp emits). */
export function extractStampTrailers(
  text: string,
): Array<{ agent: AgentKind; sessionId: string }> {
  const out: Array<{ agent: AgentKind; sessionId: string }> = [];
  const re = new RegExp(STAMP_TRAILER_SOURCE, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ agent: m[1].toLowerCase() as AgentKind, sessionId: m[2] });
  }
  return out;
}

/**
 * Build an attribution stamp for a PR body / commit.
 *
 * Local sessions stay author-private by default. Cloud sessions include a
 * shareable URL reviewers can open.
 */
export function buildStamp(input: StampInput): StampBlock {
  const visibility = input.visibility ?? (input.cloudUrl ? "cloud" : "local");
  if (visibility === "cloud" && !input.cloudUrl) {
    throw new Error(
      'buildStamp: visibility "cloud" requires cloudUrl (shareable transcript URL)',
    );
  }
  const token = stampToken(input.agent, input.sessionId);
  const label = agentLabel(input.agent);

  const lines: string[] = [
    "<!-- pr-session:begin -->",
    `**Agent session (${label}):** \`${token}\``,
  ];

  if (visibility === "cloud" && input.cloudUrl) {
    lines.push(`Shareable transcript: ${input.cloudUrl}`);
  } else {
    lines.push(
      "_Transcript is local to the author machine — not visible to reviewers. Use `pr-session lookup` locally._",
    );
  }

  if (input.title) {
    lines.push(`Session: ${input.title}`);
  }
  lines.push("<!-- pr-session:end -->");

  return {
    markdown: lines.join("\n"),
    trailers: [
      `Agent-Session: ${input.agent}/${input.sessionId}`,
      ...(input.cloudUrl ? [`Agent-Session-URL: ${input.cloudUrl}`] : []),
    ],
    token,
  };
}
