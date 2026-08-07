import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LinkRecord, SessionRecord } from "../../core/types.js";
import { extractPrUrls } from "../../core/pr-ref.js";
import { homePath } from "../paths.js";
import { settleFileScan, settleStat } from "./safe.js";

/** Decode Cursor project dir names like Users-davis-keene-github-joinera */
export function decodeCursorProjectDir(name: string): {
  cwdGuess?: string;
  repoGuess?: string;
} {
  if (name.startsWith(".")) return {};
  const m = name.match(/^Users-(.+)-github-(.+)$/);
  if (m) {
    const userEncoded = m[1];
    const repo = m[2];
    const user =
      userEncoded.includes("-") && !userEncoded.includes(".")
        ? userEncoded.replace("-", ".")
        : userEncoded;
    return {
      cwdGuess: `/Users/${user}/github/${repo}`,
      repoGuess: repo,
    };
  }
  return { repoGuess: name };
}

export async function indexCursor(options?: {
  projectsRoot?: string;
}): Promise<{ sessions: SessionRecord[]; links: LinkRecord[] }> {
  const root =
    options?.projectsRoot ?? homePath(".cursor", "projects");
  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();

  if (!fs.existsSync(root)) {
    return { sessions: [], links: [] };
  }

  let projectNames: string[] = [];
  try {
    projectNames = fs.readdirSync(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-session: skip cursor root ${root}: ${msg}\n`);
    return { sessions: [], links: [] };
  }

  for (const projectName of projectNames) {
    // Skip Cursor housekeeping project dirs — they mirror session IDs and
    // would otherwise win last-write-wins races against real repos.
    if (
      projectName.startsWith(".") ||
      projectName === "empty-window" ||
      projectName.includes("empty-window")
    ) {
      continue;
    }

    const transcriptsRoot = path.join(
      root,
      projectName,
      "agent-transcripts",
    );
    if (!fs.existsSync(transcriptsRoot)) continue;

    const decoded = decodeCursorProjectDir(projectName);

    let sessionDirs: string[] = [];
    try {
      sessionDirs = fs.readdirSync(transcriptsRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `pr-session: skip cursor dir ${transcriptsRoot}: ${msg}\n`,
      );
      continue;
    }

    for (const sessionDir of sessionDirs) {
      const dir = path.join(transcriptsRoot, sessionDir);
      if (
        !settleStat("cursor dir", dir, () => fs.statSync(dir).isDirectory())
      ) {
        continue;
      }

      const file = path.join(dir, `${sessionDir}.jsonl`);
      let target = file;
      if (!fs.existsSync(file)) {
        let alt: string | undefined;
        try {
          alt = fs.readdirSync(dir).find((n) => n.endsWith(".jsonl"));
        } catch {
          continue;
        }
        if (!alt) continue;
        target = path.join(dir, alt);
      }

      await settleFileScan("cursor", target, () =>
        scanCursorFile(target, sessionDir, decoded, sessions, links, linkKeys),
      );
    }
  }

  return { sessions: [...sessions.values()], links };
}

async function scanCursorFile(
  file: string,
  sessionId: string,
  decoded: { cwdGuess?: string; repoGuess?: string },
  sessions: Map<string, SessionRecord>,
  links: LinkRecord[],
  linkKeys: Set<string>,
): Promise<void> {
  const stat = fs.statSync(file);
  const startedAt = stat.birthtime?.toISOString?.() || stat.mtime.toISOString();
  const updatedAt = stat.mtime.toISOString();

  let title: string | undefined;
  let cloudUrl: string | undefined;
  let visibility: "local" | "cloud" = "local";
  let lineNo = 0;

  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    let obj: { role?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const text = flattenContent(obj.message?.content);
    if (!title && obj.role === "user" && text) {
      title = text.replace(/\s+/g, " ").slice(0, 120);
    }

    // Cloud agent transcripts sometimes include cursor.com links
    const cloud = text.match(
      /https:\/\/cursor\.com\/agents\/[A-Za-z0-9_-]+/,
    );
    if (cloud) {
      cloudUrl = cloud[0];
      visibility = "cloud";
    }

    if (lineNo <= 400 && text) {
      for (const pr of extractPrUrls(text)) {
        const key = `${sessionId}:${pr.owner}/${pr.repo}#${pr.number}`;
        if (linkKeys.has(key)) continue;
        linkKeys.add(key);
        const session: SessionRecord = {
          agent: "cursor",
          sessionId,
          transcriptPath: file,
          cloudUrl,
          visibility,
          cwd: decoded.cwdGuess,
          repo: decoded.repoGuess,
          startedAt,
          updatedAt,
          title,
        };
        sessions.set(`cursor:${sessionId}`, preferCursorSession(sessions.get(`cursor:${sessionId}`), session));
        links.push({
          pr,
          session,
          confidence: "medium",
          reason: "transcript-mention",
        });
      }
    }

    if (lineNo > 400 && title) break;
  }

  const record: SessionRecord = {
    agent: "cursor",
    sessionId,
    transcriptPath: file,
    cloudUrl,
    visibility,
    cwd: decoded.cwdGuess,
    repo: decoded.repoGuess,
    startedAt,
    updatedAt,
    title,
  };
  sessions.set(
    `cursor:${sessionId}`,
    preferCursorSession(sessions.get(`cursor:${sessionId}`), record),
  );
}

/** Prefer project-rooted transcripts over empty-window / cleanup mirrors. */
function preferCursorSession(
  prev: SessionRecord | undefined,
  next: SessionRecord,
): SessionRecord {
  if (!prev) return next;
  return scoreCursor(next) >= scoreCursor(prev) ? next : prev;
}

function scoreCursor(s: SessionRecord): number {
  let n = 0;
  if (s.cloudUrl) n += 100;
  if (s.repo) n += 40;
  if (s.cwd) n += 20;
  if (s.title) n += 5;
  const p = (s.transcriptPath || "").toLowerCase();
  if (p.includes("/empty-window") || p.includes("/.agent-data-cleanup")) {
    n -= 50;
  } else if (p.includes("/projects/")) {
    n += 30;
  }
  if (s.updatedAt) {
    const t = Date.parse(s.updatedAt);
    if (!Number.isNaN(t)) n += t / 1e15;
  }
  return n;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("\n");
}
