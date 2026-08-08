# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(`0.x` may include breaking changes in minor versions).

## [Unreleased]

### Added

- Compact `lookup` output: numbered match rows (confidence, agent + short id, branch, last-active, title) with an interactive picker on TTYs — type a row number to resume that session, Enter to skip; `--verbose` restores the old per-match detail
- `--n <k>` on `open` / `lookup` to resume any match by row number non-interactively
- `session` accepts unique session-id prefixes (≥6 chars), so short ids from the compact rows resolve directly

- Commit-SHA matching: indexers harvest commit SHAs from transcripts (git commit stdout patterns, Codex `session_meta.git.commit_hash`) and the resolver matches them against the PR's commit list (`commit-sha`, high confidence)
- `Agent-Session:` git trailers in PR commit messages now resolve as exact stamp matches — the trailers `stamp` emits are finally read back
- `pr-session list` — browse indexed sessions with `--repo`, `--agent`, `--since` (`7d`/`24h`/ISO), `--limit`, `--json`; each row prints its resume affordance
- Incremental indexing: per-file mtime+size scan cache at `~/.pr-session/cache.json` makes re-index near-instant; `index --full` forces a full rescan
- Fixture-based indexer tests for all three agents (`test/fixtures/`)

### Changed

- Spawned Codex subagents are grouped under their parent session in PR lookups and hidden from `list` by default; `--include-subagents` restores the individual child threads
- Compact lookup rows extend session-id prefixes past eight characters when needed to distinguish otherwise identical-looking matches
- `pr-session open` (and `lookup` / `session --open`) resume the interactive session: Claude/Codex CLI resume commands, Cursor agent deeplinks, transcript file only as fallback
- Duplicate-session merging is unified in one field-wise `mergeSessions` (score-based winner, gap backfill, timestamp union) shared by all indexers and `finalizeIndex`
- Agent kinds have a single source of truth (`AGENT_KINDS` in `pr-session/types`) — stamp regexes, CLI validation, and store validation all derive from it
- Codex scanning stops after its meta/URL window (line + byte capped) and uses file mtime for recency, cutting cold index time roughly in half
- `gh pr view` now also fetches the PR commit list (same single invocation); number-only lookups no longer re-spawn an identical failed `gh` call

### Fixed

- Codex indexer no longer clobbers session metadata (branch/repo/cwd) with `undefined` when the same session appears in both `sessions/` and `archived_sessions/`

### Security / matching hardening (adversarial review)

- Codex `session_meta.git.commit_hash` (the HEAD at session start, not session work) is no longer harvested — only commits actually created in-session match
- Codex scanning continues past the deep-scan window with a cheap regex-only tail, so late-session commits are still harvested (they usually happen late)
- `commit-sha` matches are gated on repository identity — the same SHA in a fork/mirror session no longer matches
- Commit-stdout harvesting requires git's full `[branch sha]` bracket shape
- `Agent-Session:` trailers are read only from a commit message's final paragraph, per git trailer semantics — quoted examples earlier in the body don't count
- Transcript-derived text (titles, branches, ids) is stripped of C0/C1 control characters before terminal display, blocking ANSI/OSC injection
- `list --since` and session ordering compare parsed instants, so offset ISO timestamps (`+02:00`) sort chronologically

## [0.1.0] — 2026-08-07

### Added

- Local CLI: `index`, `lookup`, `session`, `stamp`, `open`, `stats`
- Indexers for Claude Code (`pr-link` events), Codex rollouts, Cursor transcripts
- Pure core modules: resolve, stamp, types (Action-safe subpath exports)
- Local store at `~/.pr-session/index.json` with validation on load
- `agent-session://` stamps (local-private by default; cloud URL optional)
- Heuristic matching: branch + repo + time, PR-body fingerprints
- Package subpaths: `pr-session/resolve`, `/stamp`, `/types`, `/local`, `/github`
