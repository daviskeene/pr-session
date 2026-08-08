import { execFileSync } from "node:child_process";
import type { PrCommit, PrRef } from "../../core/types.js";
import { parsePrRef, prRef } from "../../core/pr-ref.js";

export interface GhPrMeta {
  ref: PrRef;
  title: string;
  body: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  commits: PrCommit[];
}

interface GhPrJson {
  number: number;
  url: string;
  title: string;
  body: string | null;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  headRepository?: { name?: string; owner?: { login?: string } };
  commits?: Array<{
    oid?: string;
    messageHeadline?: string;
    messageBody?: string;
  }>;
}

const PR_VIEW_FIELDS =
  "number,url,title,body,headRefName,createdAt,updatedAt,headRepository,commits";

/** Resolve a PR reference, using `gh` when only a number (or partial) is given. */
export function resolvePrInput(input: string): PrRef {
  const parsed = parsePrRef(input);
  if (parsed) return parsed;

  const num = input.replace(/^#/, "");
  if (/^\d+$/.test(num)) {
    return fetchPrByNumber(Number(num)).ref;
  }

  throw new Error(
    `Could not parse PR reference: ${input}. Use a URL, owner/repo#123, or a number in a git repo.`,
  );
}

export function fetchPrMeta(input: string): GhPrMeta {
  const parsed = parsePrRef(input);
  if (parsed) {
    return fetchPr(parsed);
  }
  const num = input.replace(/^#/, "");
  if (/^\d+$/.test(num)) {
    return fetchPrByNumber(Number(num));
  }
  throw new Error(`Could not parse PR reference: ${input}`);
}

function fetchPrByNumber(number: number): GhPrMeta {
  return mapGh(
    ghJson(["pr", "view", String(number), "--json", PR_VIEW_FIELDS]),
  );
}

function fetchPr(ref: PrRef): GhPrMeta {
  return mapGh(
    ghJson([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--json",
      PR_VIEW_FIELDS,
    ]),
  );
}

function mapGh(json: GhPrJson): GhPrMeta {
  // Prefer the PR URL (base/canonical repo). headRepository is the
  // contributor fork on cross-fork PRs and must not redefine the PrRef.
  const fromUrl = parseOwnerFromUrl(json.url);
  const owner =
    fromUrl?.owner || json.headRepository?.owner?.login || "unknown";
  const repo = fromUrl?.repo || json.headRepository?.name || "unknown";
  const commits: PrCommit[] = [];
  for (const c of json.commits ?? []) {
    if (typeof c?.oid !== "string" || !c.oid) continue;
    const message = [c.messageHeadline, c.messageBody]
      .filter(Boolean)
      .join("\n\n");
    commits.push(message ? { sha: c.oid, message } : { sha: c.oid });
  }
  return {
    ref: prRef(owner, repo, json.number),
    title: json.title,
    body: json.body || "",
    headBranch: json.headRefName,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    url: json.url,
    commits,
  };
}

/** Exported for unit tests — maps `gh pr view --json` into GhPrMeta. */
export function mapGhPrMeta(json: GhPrJson): GhPrMeta {
  return mapGh(json);
}

function parseOwnerFromUrl(url: string) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function ghJson(args: string[]): GhPrJson {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as GhPrJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh failed (${args.join(" ")}): ${msg}`);
  }
}
