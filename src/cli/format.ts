import type { LinkRecord } from "../core/types.js";

/** Human-readable multi-line formatting for CLI stdout. */
export function formatLinkForCli(link: LinkRecord): string {
  const s = link.session;
  const parts = [
    `${link.confidence.padEnd(6)} ${link.reason}`,
    `${s.agent}:${s.sessionId}`,
    s.visibility === "cloud" && s.cloudUrl
      ? `cloud ${s.cloudUrl}`
      : s.transcriptPath
        ? `local ${s.transcriptPath}`
        : "no-path",
  ];
  if (s.branch) parts.push(`branch ${s.branch}`);
  return parts.join("\n  ");
}
