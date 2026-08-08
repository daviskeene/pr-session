import type { LinkRecord, MatchConfidence } from "../core/types.js";
import { hyperlink, sessionOpenLinks } from "../core/resume.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function paint(text: string, code: string, on?: boolean): string {
  return on ? `${code}${text}${RESET}` : text;
}

function confidenceColor(confidence: MatchConfidence): string {
  if (confidence === "exact") return GREEN;
  if (confidence === "high") return YELLOW;
  return DIM;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `Aug 7` this year, `Aug 2025` otherwise. Empty for missing/bad dates. */
export function formatWhen(iso?: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear()
    ? `${month} ${d.getDate()}`
    : `${month} ${d.getFullYear()}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Strip C0/C1 control characters from transcript-derived text so a hostile
 * title/branch can't inject ANSI/OSC sequences into the terminal.
 */
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/**
 * Compact numbered match rows: confidence, agent:short-id, branch/repo,
 * last-active — with the session title dimmed underneath when known.
 */
export function formatLinkRows(
  links: LinkRecord[],
  opts: { color?: boolean; now?: Date } = {},
): string {
  const shortIds = links.map((link) =>
    shortestUniqueIdPrefix(link, links),
  );
  const rows = links.map((link, i) => {
    const s = link.session;
    return {
      n: String(i + 1),
      confidence: link.confidence,
      who: `${s.agent}:${shortIds[i]}`,
      where: truncate(sanitizeText(s.branch || s.repo || ""), 26),
      when: formatWhen(s.updatedAt || s.startedAt, opts.now),
      title: s.title ? sanitizeText(s.title) : undefined,
    };
  });
  const whoWidth = Math.max(...rows.map((r) => r.who.length));
  const whereWidth = Math.max(...rows.map((r) => r.where.length));

  const lines: string[] = [];
  for (const r of rows) {
    const confidence = paint(
      r.confidence.padEnd(6),
      confidenceColor(r.confidence as MatchConfidence),
      opts.color,
    );
    lines.push(
      `  ${r.n}  ${confidence} ${r.who.padEnd(whoWidth)}  ${r.where.padEnd(whereWidth)}  ${r.when}`.trimEnd(),
    );
    if (r.title) {
      lines.push(`     ${paint(`"${truncate(r.title, 60)}"`, DIM, opts.color)}`);
    }
  }
  return lines.join("\n");
}

/** Use at least 8 characters, extending only enough to distinguish rows. */
function shortestUniqueIdPrefix(
  link: LinkRecord,
  links: LinkRecord[],
): string {
  const id = sanitizeText(link.session.sessionId);
  let length = Math.min(8, id.length);
  while (
    length < id.length &&
    links.some(
      (other) =>
        other !== link &&
        other.session.agent === link.session.agent &&
        sanitizeText(other.session.sessionId).startsWith(id.slice(0, length)),
    )
  ) {
    length += 1;
  }
  return id.slice(0, length);
}

/** Parse a picker reply: 1-based match number in range, else null (skip). */
export function parsePickerAnswer(
  answer: string,
  max: number,
): number | null {
  const trimmed = answer.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= max ? n : null;
}

/** Human-readable multi-line formatting for CLI stdout. */
export function formatLinkForCli(link: LinkRecord): string {
  const s = link.session;
  const links = sessionOpenLinks(s);
  const parts = [
    `${link.confidence.padEnd(6)} ${link.reason}`,
    `${s.agent}:${sanitizeText(s.sessionId)}`,
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
