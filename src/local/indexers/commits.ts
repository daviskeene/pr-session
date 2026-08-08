/**
 * Harvest commit SHAs from transcript text.
 *
 * Matches the SHA in git's own commit confirmation output — `[branch abc1234]`
 * (including `[branch (root-commit) abc1234]`) — which only appears when a
 * commit was created inside the session. Deliberately narrow: bare hex tokens
 * are far too common in transcripts to harvest wholesale.
 */
const COMMIT_STDOUT_RE = /[ (]([0-9a-f]{7,40})\]/g;

export function harvestCommitShas(text: string, into: Set<string>): void {
  for (const m of text.matchAll(COMMIT_STDOUT_RE)) {
    into.add(m[1].toLowerCase());
  }
}
