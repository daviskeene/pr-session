/**
 * Harvest commit SHAs from transcript text.
 *
 * Matches the SHA in git's own commit confirmation output — `[branch abc1234]`
 * (including `[branch (root-commit) abc1234]`) — requiring the full bracket
 * group so bare `foo]` fragments don't match. Deliberately narrow: bare hex
 * tokens are far too common in transcripts to harvest wholesale. Transcript
 * text is still author-influenced, so downstream matching treats these as
 * high (not exact) confidence and gates on repository identity.
 */
const COMMIT_STDOUT_RE = /\[[^\[\]\n]+ ([0-9a-f]{7,40})\]/g;

export function harvestCommitShas(text: string, into: Set<string>): void {
  for (const m of text.matchAll(COMMIT_STDOUT_RE)) {
    into.add(m[1].toLowerCase());
  }
}
