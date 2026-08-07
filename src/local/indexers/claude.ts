import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LinkRecord, SessionRecord } from "../../core/types.js";
import { normalizeRepo, prRef } from "../../core/pr-ref.js";
import { homePath } from "../paths.js";
import { settleFileScan, settleStat } from "./safe.js";

interface ClaudePrLinkEvent {
  type: "pr-link";
  sessionId?: string;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  timestamp?: string;
}

export async function indexClaude(options?: {
  projectsRoot?: string;
}): Promise<{ sessions: SessionRecord[]; links: LinkRecord[] }> {
  const root =
    options?.projectsRoot ?? homePath(".claude", "projects");
  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();

  if (!fs.existsSync(root)) {
    return { sessions: [], links: [] };
  }

  let projectDirs: string[] = [];
  try {
    projectDirs = fs.readdirSync(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-session: skip claude root ${root}: ${msg}\n`);
    return { sessions: [], links: [] };
  }

  for (const projectDir of projectDirs) {
    const abs = path.join(root, projectDir);
    if (
      !settleStat("claude dir", abs, () => fs.statSync(abs).isDirectory())
    ) {
      continue;
    }

    let names: string[] = [];
    try {
      names = fs.readdirSync(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pr-session: skip claude dir ${abs}: ${msg}\n`);
      continue;
    }

    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(abs, name);
      if (!settleStat("claude file", file, () => fs.statSync(file).isFile())) {
        continue;
      }
      await settleFileScan("claude", file, () =>
        scanClaudeFile(file, sessions, links, linkKeys),
      );
    }
  }

  return { sessions: [...sessions.values()], links };
}

async function scanClaudeFile(
  file: string,
  sessions: Map<string, SessionRecord>,
  links: LinkRecord[],
  linkKeys: Set<string>,
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = path.basename(file, ".jsonl");
  let cwd: string | undefined;
  let branch: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let title: string | undefined;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sid = (obj.sessionId || obj.session_id) as string | undefined;
    if (sid) sessionId = sid;

    const ts = obj.timestamp as string | undefined;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!updatedAt || ts > updatedAt) updatedAt = ts;
    }

    if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && obj.gitBranch) {
      branch = obj.gitBranch;
    }

    if (
      obj.type === "custom-title" &&
      typeof (obj as { title?: string }).title === "string"
    ) {
      title = (obj as { title: string }).title;
    }

    if (obj.type === "pr-link") {
      const ev = obj as unknown as ClaudePrLinkEvent;
      const pr = parseClaudePr(ev);
      if (pr && ev.sessionId) {
        const key = `${ev.sessionId}:${pr.owner}/${pr.repo}#${pr.number}`;
        if (!linkKeys.has(key)) {
          linkKeys.add(key);
          const session = upsertSession(sessions, {
            agent: "claude",
            sessionId: ev.sessionId,
            transcriptPath: file,
            visibility: "local",
            cwd,
            branch,
            startedAt,
            updatedAt,
            title,
            repo: repoSlugFromCwd(cwd),
          });
          links.push({
            pr,
            session,
            confidence: "exact",
            reason: "pr-link-event",
            observedAt: ev.timestamp,
          });
        }
      }
    }
  }

  upsertSession(sessions, {
    agent: "claude",
    sessionId,
    transcriptPath: file,
    visibility: "local",
    cwd,
    branch,
    startedAt,
    updatedAt,
    title,
    repo: repoSlugFromCwd(cwd),
  });
}

function parseClaudePr(ev: ClaudePrLinkEvent) {
  if (ev.prUrl) {
    const m = ev.prUrl.match(
      /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
    );
    if (m) return prRef(m[1], m[2], Number(m[3]));
  }
  if (ev.prRepository && ev.prNumber) {
    const norm = normalizeRepo(ev.prRepository);
    if (norm) return prRef(norm.owner, norm.repo, ev.prNumber);
  }
  return null;
}

function repoSlugFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function upsertSession(
  map: Map<string, SessionRecord>,
  next: SessionRecord,
): SessionRecord {
  const key = `${next.agent}:${next.sessionId}`;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, next);
    return next;
  }
  const merged: SessionRecord = {
    ...prev,
    ...next,
    cwd: next.cwd || prev.cwd,
    branch: next.branch || prev.branch,
    repo: next.repo || prev.repo,
    title: next.title || prev.title,
    startedAt:
      prev.startedAt && next.startedAt
        ? prev.startedAt < next.startedAt
          ? prev.startedAt
          : next.startedAt
        : prev.startedAt || next.startedAt,
    updatedAt:
      prev.updatedAt && next.updatedAt
        ? prev.updatedAt > next.updatedAt
          ? prev.updatedAt
          : next.updatedAt
        : prev.updatedAt || next.updatedAt,
    transcriptPath: next.transcriptPath || prev.transcriptPath,
  };
  map.set(key, merged);
  return merged;
}
