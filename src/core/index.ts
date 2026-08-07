/** Pure Action-safe core: types, resolve, stamp, PR parsing. */
export type {
  AgentKind,
  IndexStats,
  LinkRecord,
  MatchConfidence,
  MatchReason,
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
  resolvePrsForSession,
  resolveSessionsForPr,
} from "./resolve.js";

export {
  agentLabel,
  buildStamp,
  extractStampTokens,
  parseStampToken,
  stampToken,
} from "./stamp.js";

export { detectAgentFingerprints } from "./fingerprints.js";
