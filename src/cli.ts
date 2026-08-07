#!/usr/bin/env node
/**
 * pr-session — local CLI for bidirectional PR ↔ agent-session attribution.
 *
 * Library core lives in ./core and is Action-friendly; this CLI is the
 * author-facing surface. Local transcripts stay on-machine unless a cloud URL
 * exists (e.g. Cursor cloud agents).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { formatLinkForCli } from "./cli/format.js";
import {
  buildIndex,
  buildStamp,
  defaultIndexPath,
  fetchPrMeta,
  indexStats,
  loadIndex,
  parsePrRef,
  resolvePrInput,
  resolvePrsForSession,
  resolveSessionsForPr,
  saveIndex,
  type AgentKind,
  type MatchConfidence,
} from "./index.js";

const CONFIDENCES = new Set<MatchConfidence>([
  "exact",
  "high",
  "medium",
  "low",
]);

const HELP = `pr-session — map GitHub PRs ↔ Claude Code / Codex / Cursor sessions

Usage:
  pr-session index [--json]
  pr-session lookup <pr> [--json] [--min exact|high|medium|low] [--no-heuristic]
  pr-session session <agent/id|/id> [--json]
  pr-session stamp --agent <claude|codex|cursor> --id <sessionId> [--cloud-url <url>] [--title <t>]
  pr-session open <pr>          # print best local transcript path (and open if possible)
  pr-session stats
  pr-session help

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
  process.stderr.write("Indexing Claude / Codex / Cursor sessions…\n");
  const index = await buildIndex();
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
    },
    { minConfidence: min, heuristic: !noHeuristic },
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          pr: meta.ref,
          title: meta.title,
          matches: links,
          warning: ghWarning,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${meta.ref.url}${meta.title ? ` — ${meta.title}` : ""}`);
  if (!links.length) {
    console.log("No matching sessions in the local index.");
    console.log(
      "Tip: re-run `pr-session index`, or add a stamp on future PRs.",
    );
    return;
  }
  for (const link of links) {
    console.log(`\n- ${formatLinkForCli(link)}`);
    if (link.session.visibility === "local") {
      console.log("  (local transcript — author machine only)");
    }
  }
}

async function cmdSession(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const raw = positionalArgs(args)[0];
  if (!raw) {
    console.error("session requires <agent>/<id> or <id>");
    process.exit(2);
  }

  let agent: AgentKind | undefined;
  let sessionId = raw;
  const m = raw.match(/^(claude|codex|cursor)[/:](.+)$/);
  if (m) {
    agent = m[1] as AgentKind;
    sessionId = m[2];
  }

  const index = loadIndex();
  const session = index.sessions.find(
    (s) => s.sessionId === sessionId && (agent ? s.agent === agent : true),
  );
  const links = resolvePrsForSession(index, agent, sessionId);

  if (asJson) {
    console.log(JSON.stringify({ session, prs: links }, null, 2));
    return;
  }

  if (session) {
    console.log(
      `${session.agent}:${session.sessionId} (${session.visibility})`,
    );
    if (session.transcriptPath) console.log(`  ${session.transcriptPath}`);
    if (session.cloudUrl) console.log(`  cloud ${session.cloudUrl}`);
    if (session.branch) console.log(`  branch ${session.branch}`);
  } else {
    console.log(`Session ${raw} not in index (showing linked PRs only).`);
  }

  if (!links.length) {
    console.log("No linked PRs.");
    return;
  }
  console.log("\nPRs:");
  for (const link of links) {
    console.log(`- ${link.pr.url} (${link.confidence}, ${link.reason})`);
  }
}

async function cmdStamp(args: string[]): Promise<void> {
  const agent = flagValue(args, "--agent") as AgentKind | undefined;
  const id = flagValue(args, "--id");
  const cloudUrl = flagValue(args, "--cloud-url");
  const title = flagValue(args, "--title");
  if (!agent || !id) {
    console.error("stamp requires --agent and --id");
    process.exit(2);
  }
  if (!["claude", "codex", "cursor"].includes(agent)) {
    console.error("--agent must be claude|codex|cursor");
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
  });
  const best = links[0];
  if (!best) {
    console.error("No session match to open.");
    process.exit(3);
  }
  if (best.session.cloudUrl) {
    console.log(best.session.cloudUrl);
    tryOpen(best.session.cloudUrl);
    return;
  }
  const p = best.session.transcriptPath;
  if (!p || !fs.existsSync(p)) {
    console.error(
      `Matched ${best.session.agent}:${best.session.sessionId} but transcript missing.`,
    );
    process.exit(3);
  }
  console.log(p);
  tryOpen(p);
}

async function cmdStats(): Promise<void> {
  const index = loadIndex();
  const stats = indexStats(index);
  console.log(JSON.stringify({ path: defaultIndexPath(), ...stats }, null, 2));
}

function loadPrMetaBestEffort(input: string): {
  meta: {
    ref: ReturnType<typeof parsePrRef> & object;
    body: string;
    headBranch: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    url: string;
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
      try {
        const resolved = resolvePrInput(input);
        return {
          meta: {
            ref: resolved,
            body: "",
            headBranch: "",
            createdAt: "",
            updatedAt: "",
            title: "",
            url: resolved.url,
          },
          ghWarning: `gh unavailable (${msg}); matching without PR metadata`,
        };
      } catch {
        console.error(`Could not resolve PR: ${msg}`);
        process.exit(2);
      }
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

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (
        a === "--min" ||
        a === "--agent" ||
        a === "--id" ||
        a === "--cloud-url" ||
        a === "--title"
      ) {
        i += 1;
      }
      continue;
    }
    out.push(a);
  }
  return out;
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
