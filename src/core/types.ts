/** Agent that produced a local (or cloud) coding session. */
export type AgentKind = "claude" | "codex" | "cursor";

/** How confident we are in a PR↔session link. */
export type MatchConfidence = "exact" | "high" | "medium" | "low";

/** Why a session was linked to a PR (or vice versa). */
export type MatchReason =
  | "pr-link-event"
  | "stamp"
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
