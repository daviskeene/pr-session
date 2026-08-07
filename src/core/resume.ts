import type { SessionRecord } from "./types.js";

export interface SessionOpenLinks {
  /** Shell command that resumes the interactive agent session, when supported. */
  resumeCommand?: string;
  /** Clickable file URL for the local transcript JSONL. */
  viewUrl?: string;
  /** Browser / app deep link for a cloud/shareable session. */
  openUrl?: string;
  /** Short caveats (e.g. Cursor IDE chats have no official resume URL). */
  notes: string[];
}

/**
 * Build resume / open affordances for a session.
 *
 * - Claude Code: `claude --resume <id>` (local). Cloud sessions may already
 *   carry a `cloudUrl` (`claude.ai` / Remote Control).
 * - Codex: `codex resume <id>`.
 * - Cursor cloud: `https://cursor.com/agents/bc-…` (+ `cursor://…/background-agent?bcId=`).
 * - Cursor local (Agents sidebar UUID / “Copy Agent ID”): desktop deeplink
 *   `cursor://anysphere.cursor-deeplink/agent?id=<uuid>` (opens Agents window and
 *   selects that chat when Cursor still has it). Transcript `file://` as fallback.
 *   `agent --resume` is a different id space than `agent-transcripts/`.
 */
export function sessionOpenLinks(session: SessionRecord): SessionOpenLinks {
  const notes: string[] = [];
  const viewUrl = session.transcriptPath
    ? pathToFileUrl(session.transcriptPath)
    : undefined;

  let resumeCommand: string | undefined;
  let openUrl = session.cloudUrl;

  switch (session.agent) {
    case "claude": {
      resumeCommand = withCwdHint(
        session.cwd,
        `claude --resume ${shellQuote(session.sessionId)}`,
      );
      break;
    }
    case "codex": {
      resumeCommand = withCwdHint(
        session.cwd,
        `codex resume ${shellQuote(session.sessionId)}`,
      );
      break;
    }
    case "cursor": {
      if (session.cloudUrl) {
        openUrl = session.cloudUrl;
      } else if (/^bc-/.test(session.sessionId)) {
        openUrl = `https://cursor.com/agents/${session.sessionId}`;
      } else {
        // Same shape as Glass “agent deeplink” / GlassDeeplinkHandler `/agent?id=`.
        // Works for local UUIDs that still exist in the Agents repository.
        openUrl = cursorAgentDesktopDeeplink(session.sessionId);
        notes.push(
          "Opens the Cursor Agents window and selects this chat when it is still available locally (same id as Copy Agent ID).",
        );
        if (session.cwd) {
          resumeCommand = `cursor ${shellQuote(session.cwd)}`;
          notes.push(
            "`cursor <cwd>` only opens the project folder; prefer the agent deeplink above to jump to the chat.",
          );
        }
      }
      if (openUrl?.includes("cursor.com/agents/")) {
        const id = openUrl.split("/agents/")[1]?.split(/[?#]/)[0];
        if (id?.startsWith("bc-")) {
          notes.push(
            `Desktop deeplink: ${cursorCloudAgentDesktopDeeplink(id)}`,
          );
        }
      }
      break;
    }
  }

  return { resumeCommand, viewUrl, openUrl, notes };
}

/**
 * Best action to put the user back in the interactive session.
 *
 * Preference: CLI resume (`claude --resume` / `codex resume`) → app/URL deeplink
 * → transcript path. Cursor’s `cursor <cwd>` is display-only (does not select the
 * chat), so local Cursor uses the agent deeplink instead.
 */
export type SessionLaunch =
  | { kind: "command"; command: string }
  | { kind: "url"; url: string }
  | { kind: "path"; path: string };

export function sessionLaunch(session: SessionRecord): SessionLaunch | undefined {
  const links = sessionOpenLinks(session);
  if (
    (session.agent === "claude" || session.agent === "codex") &&
    links.resumeCommand
  ) {
    return { kind: "command", command: links.resumeCommand };
  }
  if (links.openUrl) {
    return { kind: "url", url: links.openUrl };
  }
  if (session.transcriptPath) {
    return { kind: "path", path: session.transcriptPath };
  }
  return undefined;
}

/** OS-registered `cursor://` deeplink that jumps to an agent by id (Glass). */
export function cursorAgentDesktopDeeplink(agentId: string): string {
  return `cursor://anysphere.cursor-deeplink/agent?id=${encodeURIComponent(agentId)}`;
}

/** Cloud / background-agent form (also what some “Copy agent deeplink” paths emit). */
export function cursorCloudAgentDesktopDeeplink(bcId: string): string {
  return `cursor://anysphere.cursor-deeplink/background-agent?bcId=${encodeURIComponent(bcId)}`;
}

function withCwdHint(cwd: string | undefined, command: string): string {
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

/** Minimal POSIX-ish quoting for display / copy-paste. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23")}`;
}

/** OSC 8 hyperlink when stdout is a TTY; plain URL otherwise. */
export function hyperlink(url: string, label?: string): string {
  const text = label ?? url;
  if (!process.stdout.isTTY || process.env.PR_SESSION_NO_HYPERLINK) {
    return text === url ? url : `${text} (${url})`;
  }
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}
