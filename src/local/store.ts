import fs from "node:fs";
import path from "node:path";
import { AGENT_KINDS } from "../core/types.js";
import type {
  AgentKind,
  IndexStats,
  LinkRecord,
  SessionIndex,
  SessionRecord,
} from "../core/types.js";
import { homePath } from "./paths.js";

export function defaultIndexPath(): string {
  return homePath(".pr-session", "index.json");
}

/**
 * Merge duplicate session rows and rebind every link to the canonical
 * SessionRecord so mid-scan snapshots cannot leak stale metadata.
 */
export function finalizeIndex(
  sessions: SessionRecord[],
  links: LinkRecord[],
  builtAt = new Date().toISOString(),
): SessionIndex {
  const byId = new Map<string, SessionRecord>();
  for (const s of sessions) {
    upsertSession(byId, s);
  }

  const canonical = [...byId.values()];
  const rebound = links.map((link) => {
    const key = sessionKey(link.session);
    const session = byId.get(key) ?? link.session;
    return { ...link, session };
  });

  return {
    version: 1,
    builtAt,
    sessions: canonical,
    links: rebound,
  };
}

export function sessionKey(
  s: Pick<SessionRecord, "agent" | "sessionId">,
): string {
  return `${s.agent}:${s.sessionId}`;
}

/** Prefer the copy with stronger provenance when the same ID appears twice. */
export function preferSession(
  a: SessionRecord,
  b: SessionRecord,
): SessionRecord {
  return sessionScore(a) >= sessionScore(b) ? a : b;
}

function sessionScore(s: SessionRecord): number {
  let n = 0;
  if (s.cloudUrl) n += 100;
  if (s.visibility === "cloud") n += 20;
  if (s.branch) n += 15;
  if (s.title) n += 5;
  if (s.repo && s.repo !== "unknown") n += 40;
  if (s.cwd) n += 25;
  if (s.transcriptPath) n += 30;
  if (s.updatedAt) {
    const t = Date.parse(s.updatedAt);
    if (!Number.isNaN(t)) n += t / 1e15;
  }
  return n;
}

const BACKFILL_FIELDS = [
  "transcriptPath",
  "cloudUrl",
  "cwd",
  "repo",
  "branch",
  "title",
] as const;

/**
 * Merge two records for the same session. The higher-provenance copy wins
 * conflicts; gaps are backfilled from the other copy; the time range spans
 * both. Never lets an undefined field clobber a defined one.
 */
export function mergeSessions(
  a: SessionRecord,
  b: SessionRecord,
): SessionRecord {
  const winner = preferSession(a, b);
  const loser = winner === a ? b : a;
  const merged: SessionRecord = { ...winner };

  for (const field of BACKFILL_FIELDS) {
    if (merged[field] === undefined && loser[field] !== undefined) {
      merged[field] = loser[field];
    }
  }

  if (winner.visibility === "cloud" || loser.visibility === "cloud") {
    merged.visibility = "cloud";
  }

  merged.startedAt = minIso(a.startedAt, b.startedAt);
  merged.updatedAt = maxIso(a.updatedAt, b.updatedAt);

  if (a.fingerprints || b.fingerprints) {
    merged.fingerprints = [
      ...new Set([...(a.fingerprints ?? []), ...(b.fingerprints ?? [])]),
    ];
  }
  if (a.commits || b.commits) {
    merged.commits = [
      ...new Set([...(a.commits ?? []), ...(b.commits ?? [])]),
    ];
  }

  return merged;
}

/** Upsert into a `sessionKey → record` map, merging duplicates. */
export function upsertSession(
  map: Map<string, SessionRecord>,
  next: SessionRecord,
): SessionRecord {
  const key = sessionKey(next);
  const prev = map.get(key);
  const merged = prev ? mergeSessions(prev, next) : next;
  map.set(key, merged);
  return merged;
}

function minIso(a?: string, b?: string): string | undefined {
  if (a && b) return a < b ? a : b;
  return a || b;
}

function maxIso(a?: string, b?: string): string | undefined {
  if (a && b) return a > b ? a : b;
  return a || b;
}

export function saveIndex(
  index: SessionIndex,
  filePath = defaultIndexPath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(index, null, 2));
}

export function loadIndex(filePath = defaultIndexPath()): SessionIndex {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No index at ${filePath}. Run \`pr-session index\` first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid index JSON at ${filePath}: ${msg}`);
  }
  return validateIndex(raw, filePath);
}

export function validateIndex(
  raw: unknown,
  filePath = "<memory>",
): SessionIndex {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid index at ${filePath}: expected object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Unsupported index version at ${filePath}: ${String(obj.version)}`,
    );
  }
  if (typeof obj.builtAt !== "string") {
    throw new Error(`Invalid index at ${filePath}: builtAt must be a string`);
  }
  if (!Array.isArray(obj.sessions)) {
    throw new Error(`Invalid index at ${filePath}: sessions must be an array`);
  }
  if (!Array.isArray(obj.links)) {
    throw new Error(`Invalid index at ${filePath}: links must be an array`);
  }

  const agents = new Set<string>(AGENT_KINDS);
  const confidences = new Set(["exact", "high", "medium", "low"]);

  for (const [i, s] of obj.sessions.entries()) {
    if (!s || typeof s !== "object") {
      throw new Error(`Invalid index at ${filePath}: sessions[${i}]`);
    }
    const session = s as Record<string, unknown>;
    if (!agents.has(String(session.agent))) {
      throw new Error(
        `Invalid index at ${filePath}: sessions[${i}].agent=${String(session.agent)}`,
      );
    }
    if (typeof session.sessionId !== "string" || !session.sessionId) {
      throw new Error(
        `Invalid index at ${filePath}: sessions[${i}].sessionId`,
      );
    }
    if (session.visibility !== "local" && session.visibility !== "cloud") {
      throw new Error(
        `Invalid index at ${filePath}: sessions[${i}].visibility`,
      );
    }
  }

  for (const [i, l] of obj.links.entries()) {
    if (!l || typeof l !== "object") {
      throw new Error(`Invalid index at ${filePath}: links[${i}]`);
    }
    const link = l as Record<string, unknown>;
    if (!confidences.has(String(link.confidence))) {
      throw new Error(
        `Invalid index at ${filePath}: links[${i}].confidence=${String(link.confidence)}`,
      );
    }
    if (!link.pr || typeof link.pr !== "object") {
      throw new Error(`Invalid index at ${filePath}: links[${i}].pr`);
    }
    if (!link.session || typeof link.session !== "object") {
      throw new Error(`Invalid index at ${filePath}: links[${i}].session`);
    }
  }

  return raw as SessionIndex;
}

export function indexStats(index: SessionIndex): IndexStats {
  const byAgent = Object.fromEntries(
    AGENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<AgentKind, number>;
  for (const s of index.sessions) {
    byAgent[s.agent] += 1;
  }
  return {
    sessions: index.sessions.length,
    links: index.links.length,
    byAgent,
    builtAt: index.builtAt,
  };
}
