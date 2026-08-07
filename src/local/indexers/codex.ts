import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LinkRecord, SessionRecord } from "../../core/types.js";
import { extractPrUrls, normalizeRepo } from "../../core/pr-ref.js";
import { homePath } from "../paths.js";
import { settleFileScan } from "./safe.js";

export async function indexCodex(options?: {
  sessionsRoot?: string;
  archivedRoot?: string;
}): Promise<{ sessions: SessionRecord[]; links: LinkRecord[] }> {
  const roots = [
    options?.sessionsRoot ?? homePath(".codex", "sessions"),
    options?.archivedRoot ?? homePath(".codex", "archived_sessions"),
  ];

  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkJsonl(root)) {
      await settleFileScan("codex", file, () =>
        scanCodexFile(file, sessions, links, linkKeys),
      );
    }
  }

  return { sessions: [...sessions.values()], links };
}

function* walkJsonl(root: string): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
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
  sessions: Map<string, SessionRecord>,
  links: LinkRecord[],
  linkKeys: Set<string>,
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

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

  // Only scan first ~N lines deeply for meta; still scan for PR URLs lightly via sampling
  let lineNo = 0;
  const prUrlBudget = 200; // lines to search for github PR URLs after meta

  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
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
        | { branch?: string; repository_url?: string; commit_hash?: string }
        | undefined;
      if (git?.branch) branch = git.branch;
      if (git?.repository_url) {
        const norm = normalizeRepo(git.repository_url);
        if (norm) repo = `${norm.owner}/${norm.repo}`;
      }
    }

    if (obj.type === "response_item" && lineNo <= prUrlBudget) {
      const text = JSON.stringify(obj.payload ?? {});
      for (const pr of extractPrUrls(text)) {
        const key = `${sessionId}:${pr.owner}/${pr.repo}#${pr.number}`;
        if (linkKeys.has(key)) continue;
        linkKeys.add(key);
        const session: SessionRecord = {
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
        };
        sessions.set(`codex:${sessionId}`, session);
        links.push({
          pr,
          session,
          confidence: "medium",
          reason: "transcript-mention",
          observedAt: ts,
        });
      }
    }

    // Safety cap for enormous rollouts: after the URL window we still accept
    // timestamps (above) but stop once the file is absurdly large.
    if (lineNo >= 50_000) break;
  }

  const record: SessionRecord = {
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
  };
  const key = `codex:${sessionId}`;
  const prev = sessions.get(key);
  sessions.set(key, prev ? { ...prev, ...record } : record);
}
