/**
 * Convenience barrel for the CLI and local tooling.
 *
 * Action / library consumers should prefer subpath imports:
 *   - `pr-session/resolve`  — pure PR↔session matching
 *   - `pr-session/stamp`    — attribution stamps
 *   - `pr-session/types`    — shared types
 *   - `pr-session/local`    — filesystem indexers (author machine)
 *   - `pr-session/github`   — local `gh` CLI adapter
 */
export { AGENT_KINDS, isAgentKind } from "./core/types.js";
export type {
  AgentKind,
  IndexStats,
  LinkRecord,
  MatchConfidence,
  MatchReason,
  PrCommit,
  PrMeta,
  PrRef,
  ResolveOptions,
  SessionIndex,
  SessionRecord,
  SessionVisibility,
  StampBlock,
  StampInput,
} from "./core/types.js";

export {
  branchesMatch,
  commitsMatch,
  findSession,
  listSessions,
  resolvePrsForSession,
  resolveSessionsForPr,
  type ListFilters,
} from "./core/resolve.js";

export {
  buildStamp,
  extractStampTokens,
  extractStampTrailers,
  parseStampToken,
  stampToken,
} from "./core/stamp.js";

export {
  extractPrUrls,
  normalizeRepo,
  parsePrRef,
  prKey,
  prRef,
} from "./core/pr-ref.js";

export { detectAgentFingerprints } from "./core/fingerprints.js";

export {
  cursorAgentDesktopDeeplink,
  cursorCloudAgentDesktopDeeplink,
  hyperlink,
  pathToFileUrl,
  sessionLaunch,
  sessionOpenLinks,
  shellQuote,
  type SessionLaunch,
  type SessionOpenLinks,
} from "./core/resume.js";

export {
  buildIndex,
  defaultCachePath,
  defaultIndexPath,
  emptyScanCache,
  finalizeIndex,
  indexStats,
  loadIndex,
  loadScanCache,
  mergeSessions,
  preferSession,
  saveIndex,
  saveScanCache,
  validateIndex,
  type ScanCache,
} from "./local/index.js";

export {
  fetchPrMeta,
  mapGhPrMeta,
  resolvePrInput,
  type GhPrMeta,
} from "./adapters/github/index.js";

export {
  formatLinkForCli,
  formatLinkRows,
  formatWhen,
  parsePickerAnswer,
  sanitizeText,
} from "./cli/format.js";
