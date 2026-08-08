import fs from "node:fs";
import path from "node:path";
import type { AgentKind, LinkRecord, SessionRecord } from "../core/types.js";
import { prKey } from "../core/pr-ref.js";
import { homePath } from "./paths.js";
import { upsertSession } from "./store.js";

/** Bump when scanner output shape or semantics change — old entries are discarded. */
const CACHE_VERSION = 2;

/** What one transcript file contributes to the index. */
export interface FileScanResult {
  sessions: SessionRecord[];
  links: LinkRecord[];
}

interface CacheEntry {
  agent: AgentKind;
  mtimeMs: number;
  size: number;
  result: FileScanResult;
}

export interface ScanCache {
  version: number;
  files: Record<string, CacheEntry>;
}

export function defaultCachePath(): string {
  return homePath(".pr-session", "cache.json");
}

export function emptyScanCache(): ScanCache {
  return { version: CACHE_VERSION, files: {} };
}

export function loadScanCache(filePath = defaultCachePath()): ScanCache {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ScanCache;
    if (
      raw &&
      raw.version === CACHE_VERSION &&
      raw.files &&
      typeof raw.files === "object"
    ) {
      return raw;
    }
  } catch {
    /* missing or corrupt cache — rebuild from scratch */
  }
  return emptyScanCache();
}

export function saveScanCache(
  cache: ScanCache,
  filePath = defaultCachePath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cache));
}

/** Reuse the cached result while mtime+size are unchanged; rescan otherwise. */
export async function scanWithCache(
  cache: ScanCache | undefined,
  agent: AgentKind,
  file: string,
  stat: fs.Stats,
  scan: () => Promise<FileScanResult>,
): Promise<FileScanResult> {
  const entry = cache?.files[file];
  if (
    entry &&
    entry.agent === agent &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.size === stat.size
  ) {
    return entry.result;
  }
  const result = await scan();
  if (cache) {
    cache.files[file] = {
      agent,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      result,
    };
  }
  return result;
}

/** Drop this agent's entries for files that disappeared from the walk. */
export function pruneScanCache(
  cache: ScanCache,
  agent: AgentKind,
  seenFiles: Set<string>,
): void {
  for (const key of Object.keys(cache.files)) {
    if (cache.files[key].agent === agent && !seenFiles.has(key)) {
      delete cache.files[key];
    }
  }
}

/** Fold one file's scan result into an indexer's running session/link state. */
export function absorbScanResult(
  result: FileScanResult,
  sessions: Map<string, SessionRecord>,
  links: LinkRecord[],
  linkKeys: Set<string>,
): void {
  for (const s of result.sessions) {
    upsertSession(sessions, s);
  }
  for (const link of result.links) {
    const key = `${link.session.agent}:${link.session.sessionId}:${prKey(link.pr)}`;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    links.push(link);
  }
}
