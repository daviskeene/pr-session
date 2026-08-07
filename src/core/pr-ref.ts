import type { MatchConfidence, PrRef } from "./types.js";

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  exact: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function confidenceAtLeast(
  value: MatchConfidence,
  min: MatchConfidence,
): boolean {
  return CONFIDENCE_RANK[value] >= CONFIDENCE_RANK[min];
}

export function parsePrRef(input: string): PrRef | null {
  const trimmed = input.trim();

  let m = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (m) {
    return prRef(m[1], m[2], Number(m[3]));
  }

  m = trimmed.match(/^([^/#\s]+)\/([^/#\s]+)(?:#|\/pull\/)(\d+)$/i);
  if (m) {
    return prRef(m[1], m[2], Number(m[3]));
  }

  return null;
}

export function prRef(owner: string, repo: string, number: number): PrRef {
  const cleanRepo = repo.replace(/\.git$/, "");
  return {
    owner,
    repo: cleanRepo,
    number,
    url: `https://github.com/${owner}/${cleanRepo}/pull/${number}`,
  };
}

export function prKey(pr: Pick<PrRef, "owner" | "repo" | "number">): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
}

export function normalizeRepo(
  input?: string | null,
): { owner: string; repo: string } | null {
  if (!input) return null;
  const s = input.trim();

  let m = s.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };

  m = s.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };

  m = s.match(/^([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };

  return null;
}

export function extractPrUrls(text: string): PrRef[] {
  const re = /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/gi;
  const out: PrRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ref = prRef(m[1], m[2], Number(m[3]));
    const k = prKey(ref);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(ref);
    }
  }
  return out;
}

export function hoursBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(ta - tb) / (1000 * 60 * 60);
}
