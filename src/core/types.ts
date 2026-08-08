/** Every supported agent — the single source of truth. Regexes, validation
 * sets, and per-agent tallies all derive from this list. */
export const AGENT_KINDS = ["claude", "codex", "cursor"] as const;

/** Agent that produced a local (or cloud) coding session. */
export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(value: unknown): value is AgentKind {
  return (AGENT_KINDS as readonly unknown[]).includes(value);
}

/** How confident we are in a PR↔session link. */
export type MatchConfidence = "exact" | "high" | "medium" | "low";

/** Why a session was linked to a PR (or vice versa). */
export type MatchReason =
  | "pr-link-event"
  | "stamp"
  | "commit-sha"
  | "branch+repo+time"
  | "branch+repo"
  | "repo+time+fingerprint"
  | "transcript-mention";

export type SessionVisibility = "local" | "cloud";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface SessionRecord {
  agent: AgentKind;
  sessionId: string;
  /** Parent session for agent-spawned child threads, when known. */
  parentSessionId?: string;
  /** Absolute path to the primary transcript / rollout file, if local. */
  transcriptPath?: string;
  /** Cloud / shareable URL when the session is not machine-local. */
  cloudUrl?: string;
  visibility: SessionVisibility;
  cwd?: string;
  repo?: string;
  branch?: string;
  startedAt?: string;
  updatedAt?: string;
  title?: string;
  /** Soft agent fingerprint seen in linked PR bodies, if any. */
  fingerprints?: string[];
  /** Commit SHAs (full or short) observed in the session transcript. */
  commits?: string[];
}

/** One commit on a PR, as reported by the forge. */
export interface PrCommit {
  /** Full commit SHA. */
  sha: string;
  /** Commit message (headline + body) — scanned for Agent-Session trailers. */
  message?: string;
}

/** PR metadata the resolver can match against. All fields optional. */
export interface PrMeta {
  body?: string;
  headBranch?: string;
  createdAt?: string;
  updatedAt?: string;
  commits?: PrCommit[];
}

export interface LinkRecord {
  pr: PrRef;
  session: SessionRecord;
  confidence: MatchConfidence;
  reason: MatchReason;
  /** ISO timestamp when the link was observed / inferred. */
  observedAt?: string;
}

export interface IndexStats {
  sessions: number;
  links: number;
  byAgent: Record<AgentKind, number>;
  builtAt: string;
}

export interface SessionIndex {
  version: 1;
  builtAt: string;
  sessions: SessionRecord[];
  /** Exact links discovered while indexing (e.g. Claude pr-link events). */
  links: LinkRecord[];
}

export interface ResolveOptions {
  /** Prefer exact + high confidence only. */
  minConfidence?: MatchConfidence;
  /** Include heuristic matches (default true). */
  heuristic?: boolean;
  /** Return child-agent sessions separately instead of grouping them under their parent. */
  includeSubagents?: boolean;
}

export interface StampInput {
  agent: AgentKind;
  sessionId: string;
  visibility?: SessionVisibility;
  cloudUrl?: string;
  /** Optional human label. */
  title?: string;
}

export interface StampBlock {
  /** Markdown suitable for a PR body (author-local note by default). */
  markdown: string;
  /** Git commit trailer lines. */
  trailers: string[];
  /** Machine-parseable one-liner used by the resolver. */
  token: string;
}
