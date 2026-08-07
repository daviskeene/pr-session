# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(`0.x` may include breaking changes in minor versions).

## [Unreleased]

### Changed

- `pr-session open` (and `lookup` / `session --open`) resume the interactive session: Claude/Codex CLI resume commands, Cursor agent deeplinks, transcript file only as fallback

## [0.1.0] — 2026-08-07

### Added

- Local CLI: `index`, `lookup`, `session`, `stamp`, `open`, `stats`
- Indexers for Claude Code (`pr-link` events), Codex rollouts, Cursor transcripts
- Pure core modules: resolve, stamp, types (Action-safe subpath exports)
- Local store at `~/.pr-session/index.json` with validation on load
- `agent-session://` stamps (local-private by default; cloud URL optional)
- Heuristic matching: branch + repo + time, PR-body fingerprints
- Package subpaths: `pr-session/resolve`, `/stamp`, `/types`, `/local`, `/github`
