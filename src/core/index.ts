/** Pure Action-safe core: types, resolve, stamp, PR parsing. */
export { AGENT_KINDS, isAgentKind } from "./types.js";
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
} from "./types.js";

export {
  extractPrUrls,
  normalizeRepo,
  parsePrRef,
  prKey,
  prRef,
} from "./pr-ref.js";

export {
  branchesMatch,
  commitsMatch,
  findSession,
  listSessions,
  resolvePrsForSession,
  resolveSessionsForPr,
  type ListFilters,
} from "./resolve.js";

export {
  agentLabel,
  buildStamp,
  extractStampTokens,
  extractStampTrailers,
  parseStampToken,
  stampToken,
} from "./stamp.js";

export { detectAgentFingerprints } from "./fingerprints.js";

export {
  cursorAgentDesktopDeeplink,
  cursorCloudAgentDesktopDeeplink,
  pathToFileUrl,
  sessionLaunch,
  sessionOpenLinks,
  shellQuote,
  type SessionLaunch,
  type SessionOpenLinks,
} from "./resume.js";
