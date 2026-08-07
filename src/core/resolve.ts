import type {
  LinkRecord,
  MatchConfidence,
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
import { extractStampTokens } from "./stamp.js";

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
  prMeta?: {
    body?: string;
    headBranch?: string;
    createdAt?: string;
    updatedAt?: string;
  },
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

  for (const link of index.links) {
    if (prKey(link.pr) === key) push(link);
  }

  if (prMeta?.body) {
    for (const stamp of extractStampTokens(prMeta.body)) {
      const session = index.sessions.find(
        (s) =>
          s.agent === stamp.agent && s.sessionId === stamp.sessionId,
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
