import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LinkRecord, SessionRecord } from "../../core/types.js";
import { extractPrUrls, normalizeRepo } from "../../core/pr-ref.js";
import {
  absorbScanResult,
  pruneScanCache,
  scanWithCache,
  type FileScanResult,
  type ScanCache,
} from "../cache.js";
import { homePath } from "../paths.js";
import { upsertSession } from "../store.js";
import { harvestCommitShas } from "./commits.js";
import { settleFileScan } from "./safe.js";

/**
 * Deep-scan budget per rollout file. session_meta is the first line and PR
 * URLs worth linking appear early; everything after is covered by file mtime.
 * The byte cap is a safety net for pathological files — single rollout lines
 * can be hundreds of KB. Below ~1MB it starts dropping real PR-URL links.
 *
 * Past the window the scan keeps streaming but only runs the cheap commit-SHA
 * regex — commits usually happen late in a session, so stopping entirely
 * would blind commit-SHA matching for codex. Hard caps bound runaway files.
 */
const SCAN_WINDOW_LINES = 200;
const SCAN_WINDOW_BYTES = 1024 * 1024;
const HARD_CAP_LINES = 200_000;
const HARD_CAP_BYTES = 512 * 1024 * 1024;

export async function indexCodex(options?: {
  sessionsRoot?: string;
  archivedRoot?: string;
  cache?: ScanCache;
}): Promise<{ sessions: SessionRecord[]; links: LinkRecord[] }> {
  const roots = [
    options?.sessionsRoot ?? homePath(".codex", "sessions"),
    options?.archivedRoot ?? homePath(".codex", "archived_sessions"),
  ];

  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();
  const seenFiles = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkJsonl(root)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pr-session: skip codex file ${file}: ${msg}\n`);
        continue;
      }
      seenFiles.add(file);
      await settleFileScan("codex", file, async () => {
        const result = await scanWithCache(
          options?.cache,
          "codex",
          file,
          stat,
          () => scanCodexFile(file, stat),
        );
        absorbScanResult(result, sessions, links, linkKeys);
      });
    }
  }

  if (options?.cache) pruneScanCache(options.cache, "codex", seenFiles);
  return { sessions: [...sessions.values()], links };
}

function* walkJsonl(root: string): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pr-session: skip codex dir ${dir}: ${msg}\n`);
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) yield abs;
    }
  }
}

async function scanCodexFile(
  file: string,
  stat: fs.Stats,
): Promise<FileScanResult> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();

  let sessionId =
    path.basename(file).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    )?.[1] ?? path.basename(file, ".jsonl");

  let cwd: string | undefined;
  let branch: string | undefined;
  let repo: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let title: string | undefined;
  const commits = new Set<string>();

  let lineNo = 0;
  let bytesSeen = 0;
  let truncated = false;

  for await (const line of rl) {
    lineNo += 1;
    bytesSeen += line.length + 1;
    if (lineNo > HARD_CAP_LINES || bytesSeen > HARD_CAP_BYTES) {
      truncated = true;
      break;
    }
    if (!line.trim()) continue;
    harvestCommitShas(line, commits);
    if (lineNo > SCAN_WINDOW_LINES || bytesSeen > SCAN_WINDOW_BYTES) {
      // Regex-only tail: no JSON.parse past the window.
      truncated = true;
      continue;
    }
    let obj: {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.timestamp;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!updatedAt || ts > updatedAt) updatedAt = ts;
    }

    if (obj.type === "session_meta" && obj.payload) {
      const p = obj.payload;
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.timestamp === "string") {
        startedAt = p.timestamp;
      }
      const git = p.git as
        | { branch?: string; repository_url?: string }
        | undefined;
      if (git?.branch) branch = git.branch;
      if (git?.repository_url) {
        const norm = normalizeRepo(git.repository_url);
        if (norm) repo = `${norm.owner}/${norm.repo}`;
      }
      // Deliberately NOT harvesting session_meta.git.commit_hash: it is the
      // repo HEAD when the session started, not work this session produced.
    }

    if (obj.type === "response_item") {
      for (const pr of extractPrUrls(line)) {
        const key = `${sessionId}:${pr.owner}/${pr.repo}#${pr.number}`;
        if (linkKeys.has(key)) continue;
        linkKeys.add(key);
        const session = upsertSession(sessions, {
          agent: "codex",
          sessionId,
          transcriptPath: file,
          visibility: "local",
          cwd,
          branch,
          repo,
          startedAt,
          updatedAt,
          title,
          commits: commits.size ? [...commits] : undefined,
        });
        links.push({
          pr,
          session,
          confidence: "medium",
          reason: "transcript-mention",
          observedAt: ts,
        });
      }
    }
  }

  // Lines past the window are only interesting for recency; mtime covers that
  // without parsing multi-MB rollouts end to end.
  if (truncated) {
    const mtimeIso = stat.mtime.toISOString();
    if (!updatedAt || mtimeIso > updatedAt) updatedAt = mtimeIso;
  }

  upsertSession(sessions, {
    agent: "codex",
    sessionId,
    transcriptPath: file,
    visibility: "local",
    cwd,
    branch,
    repo,
    startedAt,
    updatedAt,
    title,
    commits: commits.size ? [...commits] : undefined,
  });

  return { sessions: [...sessions.values()], links };
}
