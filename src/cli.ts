#!/usr/bin/env node
/**
 * pr-session — local CLI for bidirectional PR ↔ agent-session attribution.
 *
 * Library core lives in ./core and is Action-friendly; this CLI is the
 * author-facing surface. Local transcripts stay on-machine unless a cloud URL
 * exists (e.g. Cursor cloud agents).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";
import {
  formatLinkForCli,
  formatLinkRows,
  parsePickerAnswer,
  sanitizeText,
} from "./cli/format.js";
import {
  AGENT_KINDS,
  buildIndex,
  buildStamp,
  defaultIndexPath,
  emptyScanCache,
  fetchPrMeta,
  findSession,
  indexStats,
  isAgentKind,
  listSessions,
  loadIndex,
  loadScanCache,
  parsePrRef,
  resolvePrsForSession,
  resolveSessionsForPr,
  saveIndex,
  saveScanCache,
  sessionLaunch,
  sessionOpenLinks,
  type AgentKind,
  type LinkRecord,
  type MatchConfidence,
  type PrCommit,
  type PrRef,
  type SessionRecord,
} from "./index.js";

const CONFIDENCES = new Set<MatchConfidence>([
  "exact",
  "high",
  "medium",
  "low",
]);

const HELP = `pr-session — map GitHub PRs ↔ Claude Code / Codex / Cursor sessions

Usage:
  pr-session index [--json] [--full]   # --full ignores the scan cache
  pr-session lookup <pr> [--json] [--open] [--n <k>] [--verbose] [--min exact|high|medium|low] [--no-heuristic]
  pr-session list [--repo <owner/repo|name>] [--agent <a>] [--since <7d|24h|ISO>] [--limit <n>] [--json]
  pr-session session <agent/id|id> [--json] [--open]   # id may be a unique prefix (≥6 chars)
  pr-session stamp --agent <claude|codex|cursor> --id <sessionId> [--cloud-url <url>] [--title <t>]
  pr-session open <pr> [--n <k>]  # resume/open a match (best by default; --n picks by number)
  pr-session stats
  pr-session help

Resume / open:
  Claude → \`claude --resume <id>\`   Codex → \`codex resume <id>\`
  Cursor → desktop deeplink (or cloud URL). Transcript file is last resort.
  \`--open\` / \`open\` run that action. Set PR_SESSION_NO_OPEN=1 to print only.
  Interactive \`lookup\` ends with a match picker; Enter skips it.

Notes:
  Local transcripts are for the author, not PR reviewers. Cloud session URLs
  are the only shareable form — \`stamp\` reflects that.

  The core library is designed to plug into a GitHub Action later; this CLI
  is the local-first interface.
`;

function printHelp(): void {
  console.log(HELP);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  switch (cmd) {
    case "index":
      await cmdIndex(argv.slice(1));
      break;
    case "lookup":
      await cmdLookup(argv.slice(1));
      break;
    case "list":
      await cmdList(argv.slice(1));
      break;
    case "session":
      await cmdSession(argv.slice(1));
      break;
    case "stamp":
      await cmdStamp(argv.slice(1));
      break;
    case "open":
      await cmdOpen(argv.slice(1));
      break;
    case "stats":
      await cmdStats();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

async function cmdIndex(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const full = args.includes("--full");
  process.stderr.write("Indexing Claude / Codex / Cursor sessions…\n");
  const cache = full ? emptyScanCache() : loadScanCache();
  const index = await buildIndex({ cache });
  saveScanCache(cache);
  const out = defaultIndexPath();
  saveIndex(index, out);
  const stats = indexStats(index);
  if (asJson) {
    console.log(JSON.stringify({ path: out, ...stats }, null, 2));
  } else {
    console.log(`Wrote ${out}`);
    console.log(
      `sessions=${stats.sessions} links=${stats.links} claude=${stats.byAgent.claude} codex=${stats.byAgent.codex} cursor=${stats.byAgent.cursor}`,
    );
  }
}

async function cmdLookup(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const verbose = args.includes("--verbose");
  const nRaw = flagValue(args, "--n");
  const shouldOpen = args.includes("--open") || nRaw !== undefined;
  const noHeuristic = args.includes("--no-heuristic");
  const min = parseMin(flagValue(args, "--min") ?? "low");
  const input = positionalArgs(args)[0];
  if (!input) {
    console.error("lookup requires a PR URL, owner/repo#n, or number");
    process.exit(2);
  }

  const index = loadIndex();
  const { meta, ghWarning } = loadPrMetaBestEffort(input);
  if (ghWarning) {
    process.stderr.write(`pr-session: ${ghWarning}\n`);
  }

  const links = resolveSessionsForPr(
    index,
    meta.ref,
    {
      body: meta.body,
      headBranch: meta.headBranch,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      commits: meta.commits,
    },
    { minConfidence: min, heuristic: !noHeuristic },
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          pr: meta.ref,
          title: meta.title,
          matches: links.map((link) => ({
            ...link,
            open: sessionOpenLinks(link.session),
            launch: sessionLaunch(link.session),
          })),
          warning: ghWarning,
        },
        null,
        2,
      ),
    );
    if (shouldOpen) {
      if (!links.length) {
        console.error("No session match to open.");
        process.exit(3);
      }
      launchSession(links[pickIndex(nRaw, links.length)].session);
    }
    return;
  }

  console.log(`${meta.ref.url}${meta.title ? ` — ${meta.title}` : ""}`);
  if (!links.length) {
    console.log("No matching sessions in the local index.");
    console.log(
      "Tip: re-run `pr-session index`, or add a stamp on future PRs.",
    );
    if (shouldOpen) process.exit(3);
    return;
  }

  if (verbose) {
    for (const link of links) {
      console.log(`\n- ${formatLinkForCli(link)}`);
      if (link.session.visibility === "local" && !link.session.cloudUrl) {
        console.log("  (local transcript — author machine only)");
      }
    }
  } else {
    console.log();
    console.log(formatLinkRows(links, { color: useColor() }));
    if (
      links.some(
        (l) => l.session.visibility === "local" && !l.session.cloudUrl,
      )
    ) {
      console.log("\n  local transcripts — author machine only");
    }
  }

  if (shouldOpen) {
    launchSession(links[pickIndex(nRaw, links.length)].session);
  } else if (!verbose) {
    await promptPick(links);
  }
}

function useColor(): boolean {
  return !!process.stdout.isTTY && !process.env.NO_COLOR;
}

/** Validate `--n` (1-based); defaults to the best match. */
function pickIndex(nRaw: string | undefined, count: number): number {
  if (nRaw === undefined) return 0;
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    console.error(`Invalid --n ${nRaw}. Expected 1-${count}.`);
    process.exit(2);
  }
  return n - 1;
}

/** Interactive match picker — TTY only; Enter (or anything non-numeric) skips. */
async function promptPick(links: LinkRecord[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(
      `\nOpen which? [1-${links.length}, Enter to skip]: `,
      resolve,
    ),
  );
  rl.close();
  const pick = parsePickerAnswer(answer, links.length);
  if (pick != null) launchSession(links[pick - 1].session);
}

async function cmdList(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const agentRaw = flagValue(args, "--agent");
  const repo = flagValue(args, "--repo");
  const sinceRaw = flagValue(args, "--since");
  const limitRaw = flagValue(args, "--limit");

  let agent: AgentKind | undefined;
  if (agentRaw !== undefined) {
    if (!isAgentKind(agentRaw)) {
      console.error(`--agent must be ${AGENT_KINDS.join("|")}`);
      process.exit(2);
    }
    agent = agentRaw;
  }

  let limit = 20;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`Invalid --limit ${limitRaw}. Expected a positive integer.`);
      process.exit(2);
    }
  }

  const since = sinceRaw !== undefined ? parseSince(sinceRaw) : undefined;
  const index = loadIndex();
  const sessions = listSessions(index, { agent, repo, since, limit });

  if (asJson) {
    console.log(
      JSON.stringify(
        sessions.map((session) => ({
          ...session,
          open: sessionOpenLinks(session),
          launch: sessionLaunch(session),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!sessions.length) {
    console.log("No sessions match. Try `pr-session index` first.");
    return;
  }
  for (const session of sessions) {
    const when = (session.updatedAt || session.startedAt || "").slice(0, 16);
    const where = [session.repo, session.branch]
      .filter((v): v is string => !!v)
      .map(sanitizeText)
      .join(" @ ");
    console.log(
      `- ${session.agent}:${sanitizeText(session.sessionId)}${when ? ` (${when})` : ""}${where ? ` ${where}` : ""}`,
    );
    if (session.title) console.log(`    ${sanitizeText(session.title)}`);
    const open = sessionOpenLinks(session);
    if (open.resumeCommand) console.log(`    resume ${open.resumeCommand}`);
    else if (open.openUrl) console.log(`    open ${open.openUrl}`);
  }
}

/** Accept `7d` / `24h`-style windows or any ISO date. Returns an ISO floor. */
function parseSince(raw: string): string {
  const rel = raw.match(/^(\d+)([dhw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = { h: 3600_000, d: 86_400_000, w: 604_800_000 }[
      rel[2].toLowerCase() as "h" | "d" | "w"
    ];
    return new Date(Date.now() - n * unitMs).toISOString();
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    console.error(`Invalid --since ${raw}. Use 7d, 24h, or an ISO date.`);
    process.exit(2);
  }
  return new Date(t).toISOString();
}

async function cmdSession(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const shouldOpen = args.includes("--open");
  const raw = positionalArgs(args)[0];
  if (!raw) {
    console.error("session requires <agent>/<id> or <id>");
    process.exit(2);
  }

  let agent: AgentKind | undefined;
  let sessionId = raw;
  const m = raw.match(new RegExp(`^(${AGENT_KINDS.join("|")})[/:](.+)$`));
  if (m) {
    agent = m[1] as AgentKind;
    sessionId = m[2];
  }

  const index = loadIndex();
  const found = findSession(index, agent, sessionId);
  if (found.ambiguous) {
    console.error(`Ambiguous session id ${raw}; candidates:`);
    for (const s of found.ambiguous) {
      console.error(`  ${s.agent}:${s.sessionId}`);
    }
    process.exit(2);
  }
  const session = found.session;
  const links = resolvePrsForSession(
    index,
    agent,
    session?.sessionId ?? sessionId,
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          session,
          prs: links,
          open: session ? sessionOpenLinks(session) : undefined,
          launch: session ? sessionLaunch(session) : undefined,
        },
        null,
        2,
      ),
    );
    if (shouldOpen) {
      if (!session) {
        console.error("Session not in index; cannot open.");
        process.exit(3);
      }
      launchSession(session);
    }
    return;
  }

  if (session) {
    console.log(
      `${session.agent}:${session.sessionId} (${session.visibility})`,
    );
    if (session.transcriptPath) console.log(`  ${session.transcriptPath}`);
    if (session.cloudUrl) console.log(`  cloud ${session.cloudUrl}`);
    if (session.branch) console.log(`  branch ${session.branch}`);
    const open = sessionOpenLinks(session);
    if (open.resumeCommand) console.log(`  resume ${open.resumeCommand}`);
    if (open.openUrl) console.log(`  open ${open.openUrl}`);
  } else {
    console.log(`Session ${raw} not in index (showing linked PRs only).`);
  }

  if (!links.length) {
    console.log("No linked PRs.");
  } else {
    console.log("\nPRs:");
    for (const link of links) {
      console.log(`- ${link.pr.url} (${link.confidence}, ${link.reason})`);
    }
  }

  if (shouldOpen) {
    if (!session) {
      console.error("Session not in index; cannot open.");
      process.exit(3);
    }
    launchSession(session);
  }
}

async function cmdStamp(args: string[]): Promise<void> {
  const agent = flagValue(args, "--agent");
  const id = flagValue(args, "--id");
  const cloudUrl = flagValue(args, "--cloud-url");
  const title = flagValue(args, "--title");
  if (!agent || !id) {
    console.error("stamp requires --agent and --id");
    process.exit(2);
  }
  if (!isAgentKind(agent)) {
    console.error(`--agent must be ${AGENT_KINDS.join("|")}`);
    process.exit(2);
  }

  const block = buildStamp({
    agent,
    sessionId: id,
    cloudUrl,
    title,
    visibility: cloudUrl ? "cloud" : "local",
  });

  if (args.includes("--trailers")) {
    console.log(block.trailers.join("\n"));
  } else if (args.includes("--token")) {
    console.log(block.token);
  } else {
    console.log(block.markdown);
  }
}

async function cmdOpen(args: string[]): Promise<void> {
  const input = positionalArgs(args)[0];
  const nRaw = flagValue(args, "--n");
  if (!input) {
    console.error("open requires a PR reference");
    process.exit(2);
  }
  const index = loadIndex();
  const { meta, ghWarning } = loadPrMetaBestEffort(input);
  if (ghWarning) {
    process.stderr.write(`pr-session: ${ghWarning}\n`);
  }
  const links = resolveSessionsForPr(index, meta.ref, {
    body: meta.body,
    headBranch: meta.headBranch,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    commits: meta.commits,
  });
  if (!links.length) {
    console.error("No session match to open.");
    process.exit(3);
  }
  launchSession(links[pickIndex(nRaw, links.length)].session);
}

async function cmdStats(): Promise<void> {
  const index = loadIndex();
  const stats = indexStats(index);
  console.log(JSON.stringify({ path: defaultIndexPath(), ...stats }, null, 2));
}

function loadPrMetaBestEffort(input: string): {
  meta: {
    ref: PrRef;
    body: string;
    headBranch: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    url: string;
    commits: PrCommit[];
  };
  ghWarning?: string;
} {
  try {
    const meta = fetchPrMeta(input);
    return { meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ref = parsePrRef(input);
    if (!ref) {
      // Number-only refs need gh; surface the original failure.
      console.error(`Could not resolve PR: ${msg}`);
      process.exit(2);
    }
    return {
      meta: {
        ref,
        body: "",
        headBranch: "",
        createdAt: "",
        updatedAt: "",
        title: "",
        url: ref.url,
        commits: [],
      },
      ghWarning: `gh unavailable (${msg}); matching without PR body/branch/time`,
    };
  }
}

function parseMin(raw: string): MatchConfidence {
  if (!CONFIDENCES.has(raw as MatchConfidence)) {
    console.error(
      `Invalid --min ${raw}. Expected exact|high|medium|low.`,
    );
    process.exit(2);
  }
  return raw as MatchConfidence;
}

/** Every flag that consumes the next argv token. Keep in sync with flagValue call sites. */
const VALUE_FLAGS = new Set([
  "--min",
  "--agent",
  "--id",
  "--cloud-url",
  "--title",
  "--repo",
  "--since",
  "--limit",
  "--n",
]);

function flagValue(args: string[], name: string): string | undefined {
  if (!VALUE_FLAGS.has(name)) {
    throw new Error(`flagValue: ${name} missing from VALUE_FLAGS`);
  }
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Resume / open the interactive session (claude/codex command, Cursor deeplink, or transcript). */
function launchSession(session: SessionRecord): void {
  const action = sessionLaunch(session);
  if (!action) {
    console.error(
      `Matched ${session.agent}:${session.sessionId} but have no resume/open action.`,
    );
    process.exit(3);
  }

  if (action.kind === "command") {
    console.log(action.command);
    if (process.env.PR_SESSION_NO_OPEN) return;
    const result = spawnSync(action.command, {
      shell: true,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(result.error.message);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  }

  if (action.kind === "url") {
    console.log(action.url);
    tryOpen(action.url);
    return;
  }

  if (!fs.existsSync(action.path)) {
    console.error(
      `Matched ${session.agent}:${session.sessionId} but transcript missing.`,
    );
    process.exit(3);
  }
  console.log(action.path);
  tryOpen(action.path);
}

function tryOpen(target: string): void {
  if (process.env.PR_SESSION_NO_OPEN) return;
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [target], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", target], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [target], { stdio: "ignore" });
    }
  } catch {
    /* path already printed */
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
