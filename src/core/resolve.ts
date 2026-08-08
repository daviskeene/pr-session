import type {
  AgentKind,
  LinkRecord,
  MatchConfidence,
  PrMeta,
  PrRef,
  ResolveOptions,
  SessionIndex,
  SessionRecord,
} from "./types.js";
import { detectAgentFingerprints } from "./fingerprints.js";
import {
  confidenceAtLeast,
  hoursBetween,
  normalizeRepo,
  prKey,
} from "./pr-ref.js";
import { extractStampTokens, extractStampTrailers } from "./stamp.js";

const DEFAULT_MIN: MatchConfidence = "low";

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  exact: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function resolveSessionsForPr(
  index: SessionIndex,
  pr: PrRef,
  prMeta?: PrMeta,
  options: ResolveOptions = {},
): LinkRecord[] {
  const min = options.minConfidence ?? DEFAULT_MIN;
  const heuristic = options.heuristic !== false;
  const key = prKey(pr);
  const out: LinkRecord[] = [];
  const seen = new Set<string>();

  const push = (link: LinkRecord) => {
    if (!confidenceAtLeast(link.confidence, min)) return;
    const sk = `${link.session.agent}:${link.session.sessionId}:${link.reason}`;
    if (seen.has(sk)) return;
    seen.add(sk);
    out.push(link);
  };

  const pushStamp = (stamp: { agent: AgentKind; sessionId: string }) => {
    const session = index.sessions.find(
      (s) => s.agent === stamp.agent && s.sessionId === stamp.sessionId,
    ) ?? {
      agent: stamp.agent,
      sessionId: stamp.sessionId,
      visibility: "local" as const,
    };
    push({
      pr,
      session,
      confidence: "exact",
      reason: "stamp",
    });
  };

  for (const link of index.links) {
    if (prKey(link.pr) === key) push(link);
  }

  if (prMeta?.body) {
    for (const stamp of extractStampTokens(prMeta.body)) {
      pushStamp(stamp);
    }
  }

  // Agent-Session trailers in commit messages are the stamp protocol too —
  // written once by hooks/agents, read back here.
  for (const commit of prMeta?.commits ?? []) {
    if (!commit.message) continue;
    for (const stamp of extractStampTrailers(commit.message)) {
      pushStamp(stamp);
    }
  }

  const prShas = (prMeta?.commits ?? [])
    .map((c) => c.sha.toLowerCase())
    .filter(Boolean);
  if (prShas.length) {
    for (const session of index.sessions) {
      if (commitsMatch(session.commits, prShas)) {
        push({
          pr,
          session,
          confidence: "high",
          reason: "commit-sha",
        });
      }
    }
  }

  if (heuristic) {
    const fingerprints = detectAgentFingerprints(prMeta?.body ?? "");
    const headBranch = prMeta?.headBranch;
    const prTime = prMeta?.createdAt || prMeta?.updatedAt;

    for (const session of index.sessions) {
      const repoMatch = sessionMatchesRepo(session, pr);
      const branchMatch = branchesMatch(session.branch, headBranch);
      const hrs = hoursBetween(
        session.updatedAt || session.startedAt,
        prTime,
      );

      if (branchMatch && repoMatch && hrs != null && hrs <= 72) {
        push({
          pr,
          session,
          confidence: "high",
          reason: "branch+repo+time",
        });
        continue;
      }

      if (branchMatch && repoMatch) {
        push({
          pr,
          session,
          confidence: "medium",
          reason: "branch+repo",
        });
        continue;
      }

      if (
        repoMatch &&
        hrs != null &&
        hrs <= 24 &&
        fingerprints.includes(session.agent)
      ) {
        push({
          pr,
          session,
          confidence: "medium",
          reason: "repo+time+fingerprint",
        });
      }
    }
  }

  return sortLinks(dedupeBestBySession(out));
}

export function resolvePrsForSession(
  index: SessionIndex,
  agent: SessionRecord["agent"] | undefined,
  sessionId: string,
  options: ResolveOptions = {},
): LinkRecord[] {
  const min = options.minConfidence ?? DEFAULT_MIN;
  const links = index.links.filter((l) => {
    if (l.session.sessionId !== sessionId) return false;
    if (agent && l.session.agent !== agent) return false;
    return confidenceAtLeast(l.confidence, min);
  });
  return sortLinks(dedupeBestBySessionAndPr(links));
}

function sessionMatchesRepo(session: SessionRecord, pr: PrRef): boolean {
  if (session.repo) {
    const norm = normalizeRepo(session.repo);
    if (norm) {
      return (
        norm.owner.toLowerCase() === pr.owner.toLowerCase() &&
        norm.repo.toLowerCase() === pr.repo.toLowerCase()
      );
    }
    if (session.repo.toLowerCase() === pr.repo.toLowerCase()) return true;
  }
  if (session.cwd) {
    const lower = session.cwd.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith(`/${pr.repo.toLowerCase()}`)) return true;
    if (
      lower.includes(`/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`)
    ) {
      return true;
    }
  }
  return false;
}

function dedupeBestBySession(links: LinkRecord[]): LinkRecord[] {
  const best = new Map<string, LinkRecord>();
  for (const link of links) {
    const k = `${link.session.agent}:${link.session.sessionId}`;
    const prev = best.get(k);
    if (
      !prev ||
      CONFIDENCE_RANK[link.confidence] > CONFIDENCE_RANK[prev.confidence]
    ) {
      best.set(k, link);
    }
  }
  return [...best.values()];
}

function dedupeBestBySessionAndPr(links: LinkRecord[]): LinkRecord[] {
  const best = new Map<string, LinkRecord>();
  for (const link of links) {
    const k = `${link.session.agent}:${link.session.sessionId}:${prKey(link.pr)}`;
    const prev = best.get(k);
    if (
      !prev ||
      CONFIDENCE_RANK[link.confidence] > CONFIDENCE_RANK[prev.confidence]
    ) {
      best.set(k, link);
    }
  }
  return [...best.values()];
}

/**
 * Find a session by exact id, or by unique short-id prefix (≥6 chars —
 * matches the 8-char ids the compact CLI rows display).
 */
export function findSession(
  index: SessionIndex,
  agent: AgentKind | undefined,
  idOrPrefix: string,
): { session?: SessionRecord; ambiguous?: SessionRecord[] } {
  const pool = index.sessions.filter((s) => !agent || s.agent === agent);
  const exact = pool.find((s) => s.sessionId === idOrPrefix);
  if (exact) return { session: exact };
  if (idOrPrefix.length >= 6) {
    const hits = pool.filter((s) => s.sessionId.startsWith(idOrPrefix));
    if (hits.length === 1) return { session: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  return {};
}

export interface ListFilters {
  agent?: AgentKind;
  /** `owner/repo`, or a bare repo name matched against repo/cwd tails. */
  repo?: string;
  /** ISO timestamp lower bound on updatedAt (or startedAt as fallback). */
  since?: string;
  limit?: number;
}

/** Filter + sort the indexed sessions, most recently active first. */
export function listSessions(
  index: SessionIndex,
  filters: ListFilters = {},
): SessionRecord[] {
  const repoFilter = filters.repo?.toLowerCase();
  const out = index.sessions.filter((s) => {
    if (filters.agent && s.agent !== filters.agent) return false;
    if (repoFilter && !matchesRepoFilter(s, repoFilter)) return false;
    if (filters.since) {
      const t = s.updatedAt || s.startedAt;
      if (!t || t < filters.since) return false;
    }
    return true;
  });
  out.sort((a, b) =>
    (b.updatedAt || b.startedAt || "").localeCompare(
      a.updatedAt || a.startedAt || "",
    ),
  );
  return filters.limit != null ? out.slice(0, filters.limit) : out;
}

function matchesRepoFilter(s: SessionRecord, filter: string): boolean {
  const cwd = s.cwd?.toLowerCase().replace(/\\/g, "/");
  if (filter.includes("/")) {
    const norm = normalizeRepo(s.repo);
    if (norm && `${norm.owner}/${norm.repo}`.toLowerCase() === filter) {
      return true;
    }
    return !!cwd?.includes(`/${filter}`);
  }
  const repoTail = s.repo?.toLowerCase().split("/").pop();
  if (repoTail === filter) return true;
  return !!cwd?.endsWith(`/${filter}`);
}

/**
 * A session commit matches a PR commit on full-SHA equality or short-SHA
 * prefix (≥7 hex chars — git's own abbreviation floor).
 */
export function commitsMatch(
  sessionCommits: string[] | undefined,
  prShas: string[],
): boolean {
  if (!sessionCommits?.length || !prShas.length) return false;
  for (const commit of sessionCommits) {
    const c = commit.toLowerCase();
    if (c.length < 7) continue;
    for (const sha of prShas) {
      if (sha.startsWith(c)) return true;
    }
  }
  return false;
}

/** Exact branch match, or path-segment suffix at a `/` boundary. */
export function branchesMatch(
  sessionBranch?: string,
  headBranch?: string,
): boolean {
  if (!sessionBranch || !headBranch) return false;
  if (sessionBranch === headBranch) return true;
  return (
    sessionBranch.endsWith(`/${headBranch}`) ||
    headBranch.endsWith(`/${sessionBranch}`)
  );
}

function sortLinks(links: LinkRecord[]): LinkRecord[] {
  return [...links].sort((a, b) => {
    const d = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (d !== 0) return d;
    return (b.observedAt || "").localeCompare(a.observedAt || "");
  });
}
