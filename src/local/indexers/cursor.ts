import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LinkRecord, SessionRecord } from "../../core/types.js";
import { extractPrUrls } from "../../core/pr-ref.js";
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
  cache?: ScanCache;
}): Promise<{ sessions: SessionRecord[]; links: LinkRecord[] }> {
  const root =
    options?.projectsRoot ?? homePath(".cursor", "projects");
  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();
  const seenFiles = new Set<string>();

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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `pr-session: skip cursor dir ${dir}: ${msg}\n`,
          );
          continue;
        }
        if (!alt) continue;
        target = path.join(dir, alt);
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `pr-session: skip cursor file ${target}: ${msg}\n`,
        );
        continue;
      }
      seenFiles.add(target);
      await settleFileScan("cursor", target, async () => {
        const result = await scanWithCache(
          options?.cache,
          "cursor",
          target,
          stat,
          () => scanCursorFile(target, sessionDir, decoded, stat),
        );
        absorbScanResult(result, sessions, links, linkKeys);
      });
    }
  }

  if (options?.cache) pruneScanCache(options.cache, "cursor", seenFiles);
  return { sessions: [...sessions.values()], links };
}

async function scanCursorFile(
  file: string,
  sessionId: string,
  decoded: { cwdGuess?: string; repoGuess?: string },
  stat: fs.Stats,
): Promise<FileScanResult> {
  const startedAt = stat.birthtime?.toISOString?.() || stat.mtime.toISOString();
  const updatedAt = stat.mtime.toISOString();

  const sessions = new Map<string, SessionRecord>();
  const links: LinkRecord[] = [];
  const linkKeys = new Set<string>();

  let title: string | undefined;
  let cloudUrl: string | undefined;
  let visibility: "local" | "cloud" = "local";
  const commits = new Set<string>();
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
    if (text) harvestCommitShas(text, commits);
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
        const session = upsertSession(sessions, {
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
          commits: commits.size ? [...commits] : undefined,
        });
        links.push({
          pr,
          session,
          confidence: "medium",
          reason: "transcript-mention",
        });
      }
    }
  }

  upsertSession(sessions, {
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
    commits: commits.size ? [...commits] : undefined,
  });

  return { sessions: [...sessions.values()], links };
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
