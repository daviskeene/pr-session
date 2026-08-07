import type { LinkRecord } from "../core/types.js";
import { hyperlink, sessionOpenLinks } from "../core/resume.js";

/** Human-readable multi-line formatting for CLI stdout. */
export function formatLinkForCli(link: LinkRecord): string {
  const s = link.session;
  const links = sessionOpenLinks(s);
  const parts = [
    `${link.confidence.padEnd(6)} ${link.reason}`,
    `${s.agent}:${s.sessionId}`,
  ];

  if (links.openUrl) {
    parts.push(`open ${hyperlink(links.openUrl)}`);
  } else if (s.transcriptPath) {
    parts.push(`local ${s.transcriptPath}`);
  } else {
    parts.push("no-path");
  }

  if (links.viewUrl) {
    parts.push(`view ${hyperlink(links.viewUrl, links.viewUrl)}`);
  }
  if (links.resumeCommand) {
    parts.push(`resume ${links.resumeCommand}`);
  }
  if (s.branch) parts.push(`branch ${s.branch}`);
  for (const note of links.notes) {
    parts.push(`note ${note}`);
  }
  return parts.join("\n  ");
}
