import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchesMatch,
  buildStamp,
  commitsMatch,
  findSession,
  listSessions,
  detectAgentFingerprints,
  extractStampTokens,
  extractStampTrailers,
  finalizeIndex,
  mapGhPrMeta,
  parsePrRef,
  preferSession,
  resolvePrsForSession,
  resolveSessionsForPr,
  sessionLaunch,
  sessionOpenLinks,
  stampToken,
  validateIndex,
  type LinkRecord,
  type SessionIndex,
  type SessionRecord,
} from "../src/index.js";

describe("parsePrRef", () => {
  it("parses github URLs", () => {
    const ref = parsePrRef("https://github.com/joinhandshake/joinera/pull/15451");
    assert.deepEqual(ref, {
      owner: "joinhandshake",
      repo: "joinera",
      number: 15451,
      url: "https://github.com/joinhandshake/joinera/pull/15451",
    });
  });

  it("parses owner/repo#n", () => {
    const ref = parsePrRef("joinhandshake/joinera#15451");
    assert.equal(ref?.number, 15451);
  });
});

describe("stamps", () => {
  it("round-trips tokens", () => {
    const token = stampToken("claude", "abc-123");
    assert.equal(token, "agent-session://claude/abc-123");
    const parsed = extractStampTokens(`see ${token} please`);
    assert.deepEqual(parsed, [{ agent: "claude", sessionId: "abc-123" }]);
  });

  it("marks local transcripts as author-private", () => {
    const block = buildStamp({
      agent: "cursor",
      sessionId: "sess-1",
    });
    assert.match(block.markdown, /local to the author/);
    assert.doesNotMatch(block.markdown, /Shareable transcript/);
  });

  it("includes cloud URL when provided", () => {
    const block = buildStamp({
      agent: "cursor",
      sessionId: "sess-1",
      cloudUrl: "https://cursor.com/agents/abc",
    });
    assert.match(block.markdown, /Shareable transcript/);
  });
});

describe("resolveSessionsForPr", () => {
  const index: SessionIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    sessions: [
      {
        agent: "claude",
        sessionId: "sess-exact",
        visibility: "local",
        transcriptPath: "/tmp/a.jsonl",
        repo: "joinhandshake/joinera",
        branch: "feature/x",
      },
      {
        agent: "codex",
        sessionId: "sess-branch",
        visibility: "local",
        repo: "joinhandshake/joinera",
        branch: "feature/x",
        updatedAt: "2026-07-09T12:00:00.000Z",
      },
    ],
    links: [
      {
        pr: {
          owner: "joinhandshake",
          repo: "joinera",
          number: 15451,
          url: "https://github.com/joinhandshake/joinera/pull/15451",
        },
        session: {
          agent: "claude",
          sessionId: "sess-exact",
          visibility: "local",
        },
        confidence: "exact",
        reason: "pr-link-event",
      },
    ],
  };

  it("returns exact pr-link matches", () => {
    const links = resolveSessionsForPr(
      index,
      {
        owner: "joinhandshake",
        repo: "joinera",
        number: 15451,
        url: "https://github.com/joinhandshake/joinera/pull/15451",
      },
      {},
      { heuristic: false },
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].session.sessionId, "sess-exact");
  });

  it("resolves stamps from PR body", () => {
    const links = resolveSessionsForPr(
      index,
      {
        owner: "joinhandshake",
        repo: "joinera",
        number: 99,
        url: "https://github.com/joinhandshake/joinera/pull/99",
      },
      { body: "agent-session://claude/sess-exact" },
      { heuristic: false },
    );
    assert.equal(links[0]?.reason, "stamp");
  });

  it("heuristically matches branch+repo+time", () => {
    const links = resolveSessionsForPr(
      index,
      {
        owner: "joinhandshake",
        repo: "joinera",
        number: 100,
        url: "https://github.com/joinhandshake/joinera/pull/100",
      },
      {
        headBranch: "feature/x",
        createdAt: "2026-07-09T14:00:00.000Z",
      },
    );
    const codex = links.find((l) => l.session.sessionId === "sess-branch");
    assert.ok(codex);
    assert.equal(codex.reason, "branch+repo+time");
  });

  it("dedupes stamp + indexed link for the same session without heuristics", () => {
    const links = resolveSessionsForPr(
      index,
      {
        owner: "joinhandshake",
        repo: "joinera",
        number: 15451,
        url: "https://github.com/joinhandshake/joinera/pull/15451",
      },
      { body: "agent-session://claude/sess-exact" },
      { heuristic: false },
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].confidence, "exact");
  });

  it("groups spawned subagents under their parent by default", () => {
    const parent: SessionRecord = {
      agent: "codex",
      sessionId: "parent",
      visibility: "local",
      repo: "joinhandshake/joinera",
    };
    const child: SessionRecord = {
      agent: "codex",
      sessionId: "child",
      parentSessionId: "parent",
      visibility: "local",
      repo: "joinhandshake/joinera",
      commits: ["aaaa1111"],
    };
    const groupedIndex: SessionIndex = {
      version: 1,
      builtAt: "2026-08-08T00:00:00.000Z",
      sessions: [parent, child],
      links: [],
    };
    const pr = {
      owner: "joinhandshake",
      repo: "joinera",
      number: 101,
      url: "https://github.com/joinhandshake/joinera/pull/101",
    };
    const meta = {
      commits: [{ sha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555" }],
    };

    const grouped = resolveSessionsForPr(groupedIndex, pr, meta);
    assert.deepEqual(grouped.map((l) => l.session.sessionId), ["parent"]);

    const separate = resolveSessionsForPr(groupedIndex, pr, meta, {
      includeSubagents: true,
    });
    assert.deepEqual(separate.map((l) => l.session.sessionId), ["child"]);
  });

  it("hides a spawned subagent when its parent is not indexed", () => {
    const child: SessionRecord = {
      agent: "codex",
      sessionId: "orphan-child",
      parentSessionId: "missing-parent",
      visibility: "local",
      repo: "joinhandshake/joinera",
      branch: "feature/x",
    };
    const orphanIndex: SessionIndex = {
      version: 1,
      builtAt: "2026-08-08T00:00:00.000Z",
      sessions: [child],
      links: [],
    };
    const links = resolveSessionsForPr(
      orphanIndex,
      {
        owner: "joinhandshake",
        repo: "joinera",
        number: 102,
        url: "https://github.com/joinhandshake/joinera/pull/102",
      },
      { headBranch: "feature/x" },
    );
    assert.equal(links.length, 0);
  });
});

describe("commit-sha matching", () => {
  const pr = {
    owner: "acme",
    repo: "demo",
    number: 5,
    url: "https://github.com/acme/demo/pull/5",
  };
  const index: SessionIndex = {
    version: 1,
    builtAt: "2026-08-01T00:00:00.000Z",
    sessions: [
      {
        agent: "codex",
        sessionId: "sess-commit",
        visibility: "local",
        repo: "acme/demo",
        commits: ["aaaa1111"],
      },
      {
        agent: "claude",
        sessionId: "sess-other",
        visibility: "local",
        commits: ["ffff0000"],
      },
      {
        // Same commit SHA but a different repo — a fork/mirror, not this PR.
        agent: "cursor",
        sessionId: "sess-fork",
        visibility: "local",
        repo: "fork/demo",
        commits: ["aaaa1111"],
      },
    ],
    links: [],
  };

  it("matches a session by short-SHA prefix at high confidence", () => {
    const links = resolveSessionsForPr(index, pr, {
      commits: [{ sha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555" }],
    });
    assert.equal(links.length, 1);
    assert.equal(links[0].session.sessionId, "sess-commit");
    assert.equal(links[0].confidence, "high");
    assert.equal(links[0].reason, "commit-sha");
  });

  it("rejects same-SHA matches from a different repo", () => {
    const links = resolveSessionsForPr(index, pr, {
      commits: [{ sha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555" }],
    });
    assert.ok(
      !links.some((l) => l.session.sessionId === "sess-fork"),
      "fork session must not match on commit SHA alone",
    );
  });

  it("resolves Agent-Session trailers in commit messages as exact stamps", () => {
    const links = resolveSessionsForPr(index, pr, {
      commits: [
        {
          sha: "1234123412341234123412341234123412341234",
          message:
            "Add login\n\nAgent-Session: claude/sess-other",
        },
      ],
    });
    const stamp = links.find((l) => l.reason === "stamp");
    assert.ok(stamp, "trailer produced a stamp link");
    assert.equal(stamp.confidence, "exact");
    assert.equal(stamp.session.sessionId, "sess-other");
    assert.equal(stamp.session.agent, "claude");
  });

  it("commitsMatch requires at least 7 hex chars", () => {
    const sha = ["aaaa1111bbbb2222cccc3333dddd4444eeee5555"];
    assert.equal(commitsMatch(["aaaa111"], sha), true);
    assert.equal(commitsMatch(["AAAA1111BBBB"], sha), true);
    assert.equal(commitsMatch(["aaaa11"], sha), false);
    assert.equal(commitsMatch(["9999999"], sha), false);
    assert.equal(commitsMatch(undefined, sha), false);
    assert.equal(commitsMatch(["aaaa111"], []), false);
  });
});

describe("extractStampTrailers", () => {
  it("parses trailer lines and ignores inline token mentions", () => {
    const text = [
      "Fix the thing",
      "",
      "see agent-session://codex/not-a-trailer inline",
      "Agent-Session: claude/abc-123",
      "Agent-Session: cursor/bc-999",
    ].join("\n");
    assert.deepEqual(extractStampTrailers(text), [
      { agent: "claude", sessionId: "abc-123" },
      { agent: "cursor", sessionId: "bc-999" },
    ]);
  });

  it("only reads the final paragraph, per git trailer semantics", () => {
    const text = [
      "Add docs",
      "",
      "Example usage:",
      "Agent-Session: claude/quoted-example",
      "",
      "Agent-Session: codex/real-trailer",
    ].join("\n");
    assert.deepEqual(extractStampTrailers(text), [
      { agent: "codex", sessionId: "real-trailer" },
    ]);
  });
});

describe("resolvePrsForSession", () => {
  it("keeps multiple distinct PRs for one session", () => {
    const session: SessionRecord = {
      agent: "claude",
      sessionId: "multi",
      visibility: "local",
    };
    const index: SessionIndex = {
      version: 1,
      builtAt: new Date().toISOString(),
      sessions: [session],
      links: [
        {
          pr: {
            owner: "org",
            repo: "repo",
            number: 1,
            url: "https://github.com/org/repo/pull/1",
          },
          session,
          confidence: "exact",
          reason: "pr-link-event",
        },
        {
          pr: {
            owner: "org",
            repo: "repo",
            number: 2,
            url: "https://github.com/org/repo/pull/2",
          },
          session,
          confidence: "exact",
          reason: "pr-link-event",
        },
      ],
    };
    const prs = resolvePrsForSession(index, "claude", "multi");
    assert.equal(prs.length, 2);
    assert.deepEqual(
      prs.map((l) => l.pr.number).sort(),
      [1, 2],
    );
  });
});

describe("listSessions", () => {
  const index: SessionIndex = {
    version: 1,
    builtAt: "2026-08-07T00:00:00.000Z",
    sessions: [
      {
        agent: "claude",
        sessionId: "old",
        visibility: "local",
        repo: "demo",
        cwd: "/Users/dev/github/demo",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        agent: "codex",
        sessionId: "recent",
        visibility: "local",
        repo: "acme/demo",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      {
        agent: "cursor",
        sessionId: "elsewhere",
        visibility: "local",
        repo: "acme/widgets",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
      {
        agent: "codex",
        sessionId: "child",
        parentSessionId: "recent",
        visibility: "local",
        repo: "acme/demo",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
    links: [],
  };

  it("sorts most recently active first", () => {
    const ids = listSessions(index).map((s) => s.sessionId);
    assert.deepEqual(ids, ["recent", "elsewhere", "old"]);
  });

  it("filters by agent, repo, since, and limit", () => {
    assert.deepEqual(
      listSessions(index, { agent: "codex" }).map((s) => s.sessionId),
      ["recent"],
    );
    // Bare name matches repo tails and cwd tails across owners.
    assert.deepEqual(
      listSessions(index, { repo: "demo" }).map((s) => s.sessionId),
      ["recent", "old"],
    );
    // owner/repo form is exact.
    assert.deepEqual(
      listSessions(index, { repo: "acme/demo" }).map((s) => s.sessionId),
      ["recent"],
    );
    assert.deepEqual(
      listSessions(index, { since: "2026-08-01T00:00:00.000Z" }).map(
        (s) => s.sessionId,
      ),
      ["recent", "elsewhere"],
    );
    assert.deepEqual(
      listSessions(index, { limit: 1 }).map((s) => s.sessionId),
      ["recent"],
    );
  });

  it("hides subagents by default and includes them on request", () => {
    assert.ok(!listSessions(index).some((s) => s.sessionId === "child"));
    assert.equal(
      listSessions(index, { includeSubagents: true })[0].sessionId,
      "child",
    );
  });

  it("compares offset ISO timestamps chronologically, not lexically", () => {
    const offsetIndex: SessionIndex = {
      version: 1,
      builtAt: "2026-08-07T00:00:00.000Z",
      sessions: [
        {
          agent: "claude",
          sessionId: "offset",
          visibility: "local",
          // 2026-07-31T23:00:00Z — before the filter despite the "08-01" text
          updatedAt: "2026-08-01T01:00:00+02:00",
        },
      ],
      links: [],
    };
    assert.equal(
      listSessions(offsetIndex, { since: "2026-08-01T00:00:00.000Z" }).length,
      0,
    );
  });
});

describe("findSession", () => {
  const index: SessionIndex = {
    version: 1,
    builtAt: "2026-08-07T00:00:00.000Z",
    sessions: [
      { agent: "claude", sessionId: "b0d48547-882c-4b82", visibility: "local" },
      { agent: "claude", sessionId: "b0d48500-1111-2222", visibility: "local" },
      { agent: "codex", sessionId: "019f8676-a907-7b63", visibility: "local" },
    ],
    links: [],
  };

  it("finds by exact id and unique prefix", () => {
    assert.equal(
      findSession(index, undefined, "019f8676-a907-7b63").session?.agent,
      "codex",
    );
    assert.equal(
      findSession(index, undefined, "019f8676").session?.agent,
      "codex",
    );
  });

  it("reports ambiguity and rejects short prefixes", () => {
    const unique = findSession(index, undefined, "b0d4854");
    assert.equal(unique.session?.sessionId, "b0d48547-882c-4b82");
    const ambiguous = findSession(index, undefined, "b0d485");
    assert.equal(ambiguous.session, undefined);
    assert.equal(ambiguous.ambiguous?.length, 2);
    const tooShort = findSession(index, undefined, "b0d4");
    assert.equal(tooShort.session, undefined);
    assert.equal(tooShort.ambiguous, undefined);
  });

  it("scopes by agent when given", () => {
    assert.equal(findSession(index, "claude", "019f8676").session, undefined);
    assert.equal(
      findSession(index, "codex", "019f8676").session?.sessionId,
      "019f8676-a907-7b63",
    );
  });
});

describe("branchesMatch", () => {
  it("matches exact and path-segment suffixes only", () => {
    assert.equal(branchesMatch("feature/x", "feature/x"), true);
    assert.equal(branchesMatch("user/feature/x", "feature/x"), true);
    assert.equal(branchesMatch("hotfix", "fix"), false);
    assert.equal(branchesMatch("fix", "hotfix"), false);
  });
});

describe("mapGhPrMeta", () => {
  it("prefers PR URL repo over headRepository fork", () => {
    const meta = mapGhPrMeta({
      number: 42,
      url: "https://github.com/joinhandshake/joinera/pull/42",
      title: "fork PR",
      body: null,
      headRefName: "feature",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      headRepository: {
        name: "joinera",
        owner: { login: "contributor-fork" },
      },
    });
    assert.equal(meta.ref.owner, "joinhandshake");
    assert.equal(meta.ref.repo, "joinera");
    assert.equal(meta.ref.number, 42);
  });

  it("maps PR commits into sha+message", () => {
    const meta = mapGhPrMeta({
      number: 43,
      url: "https://github.com/acme/demo/pull/43",
      title: "t",
      body: null,
      headRefName: "feature",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      commits: [
        {
          oid: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
          messageHeadline: "Add login",
          messageBody: "Agent-Session: codex/sess-1",
        },
        { oid: "", messageHeadline: "dropped" },
      ],
    });
    assert.equal(meta.commits.length, 1);
    assert.equal(
      meta.commits[0].sha,
      "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
    );
    assert.match(meta.commits[0].message ?? "", /Agent-Session: codex\/sess-1/);
  });
});

describe("finalizeIndex", () => {
  it("rebinds links to the canonical session record", () => {
    const stale: SessionRecord = {
      agent: "claude",
      sessionId: "s1",
      visibility: "local",
      branch: "old",
      transcriptPath: "/tmp/old.jsonl",
    };
    const fresh: SessionRecord = {
      agent: "claude",
      sessionId: "s1",
      visibility: "local",
      branch: "new",
      transcriptPath: "/tmp/new.jsonl",
      repo: "org/repo",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const link: LinkRecord = {
      pr: {
        owner: "org",
        repo: "repo",
        number: 1,
        url: "https://github.com/org/repo/pull/1",
      },
      session: stale,
      confidence: "exact",
      reason: "pr-link-event",
    };
    const index = finalizeIndex([stale, fresh], [link]);
    assert.equal(index.sessions.length, 1);
    assert.equal(index.sessions[0].branch, "new");
    assert.equal(index.links[0].session.branch, "new");
    assert.equal(index.links[0].session.transcriptPath, "/tmp/new.jsonl");
  });

  it("preferSession keeps project transcript over empty-window mirror", () => {
    const noise: SessionRecord = {
      agent: "cursor",
      sessionId: "same",
      visibility: "local",
      transcriptPath:
        "/Users/x/.cursor/projects/empty-window/agent-transcripts/same/same.jsonl",
      repo: "empty-window",
    };
    const real: SessionRecord = {
      agent: "cursor",
      sessionId: "same",
      visibility: "local",
      transcriptPath:
        "/Users/x/.cursor/projects/Users-x-github-joinera/agent-transcripts/same/same.jsonl",
      repo: "joinera",
      cwd: "/Users/x/github/joinera",
    };
    assert.equal(preferSession(noise, real).repo, "joinera");
    const index = finalizeIndex([noise, real], []);
    assert.equal(index.sessions[0].repo, "joinera");
  });
});

describe("buildStamp validation", () => {
  it("rejects cloud visibility without cloudUrl", () => {
    assert.throws(
      () =>
        buildStamp({
          agent: "cursor",
          sessionId: "x",
          visibility: "cloud",
        }),
      /cloudUrl/,
    );
  });
});

describe("validateIndex", () => {
  it("rejects malformed indexes", () => {
    assert.throws(() => validateIndex({ version: 1 }, "t"), /builtAt/);
    assert.throws(
      () =>
        validateIndex(
          {
            version: 1,
            builtAt: "now",
            sessions: [{ agent: "nope", sessionId: "x", visibility: "local" }],
            links: [],
          },
          "t",
        ),
      /agent/,
    );
    assert.throws(
      () =>
        validateIndex(
          {
            version: 1,
            builtAt: "now",
            sessions: [
              {
                agent: "codex",
                sessionId: "x",
                parentSessionId: 42,
                visibility: "local",
              },
            ],
            links: [],
          },
          "t",
        ),
      /parentSessionId/,
    );
  });

  it("accepts a minimal valid index", () => {
    const index = validateIndex({
      version: 1,
      builtAt: "2026-01-01T00:00:00.000Z",
      sessions: [
        { agent: "claude", sessionId: "s", visibility: "local" },
      ],
      links: [],
    });
    assert.equal(index.sessions.length, 1);
  });
});

describe("fingerprints", () => {
  it("detects Claude and Cursor markers", () => {
    assert.deepEqual(
      detectAgentFingerprints(
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      ),
      ["claude"],
    );
    assert.deepEqual(
      detectAgentFingerprints("Made with [Cursor](https://cursor.com)"),
      ["cursor"],
    );
  });
});

describe("sessionOpenLinks", () => {
  it("builds Claude resume + file view URL", () => {
    const links = sessionOpenLinks({
      agent: "claude",
      sessionId: "abc-123",
      visibility: "local",
      cwd: "/Users/you/github/joinera",
      transcriptPath:
        "/Users/you/.claude/projects/-Users-you-github-joinera/abc-123.jsonl",
    });
    assert.equal(
      links.resumeCommand,
      "cd /Users/you/github/joinera && claude --resume abc-123",
    );
    assert.equal(
      links.viewUrl,
      "file:///Users/you/.claude/projects/-Users-you-github-joinera/abc-123.jsonl",
    );
  });

  it("builds Codex resume command", () => {
    const links = sessionOpenLinks({
      agent: "codex",
      sessionId: "019a4faf-ce63-7b11-98a5-a9966f0f6e0d",
      visibility: "local",
    });
    assert.equal(
      links.resumeCommand,
      "codex resume 019a4faf-ce63-7b11-98a5-a9966f0f6e0d",
    );
  });

  it("uses Cursor cloud URL / deeplink note for bc- ids", () => {
    const links = sessionOpenLinks({
      agent: "cursor",
      sessionId: "bc-abc",
      visibility: "cloud",
    });
    assert.equal(links.openUrl, "https://cursor.com/agents/bc-abc");
    assert.ok(
      links.notes.some((n) => n.includes("cursor://anysphere.cursor-deeplink")),
    );
  });

  it("builds Cursor local agent desktop deeplink from Agent ID", () => {
    const id = "3b66e79d-cf6f-445a-aa7f-df5094f26b06";
    const links = sessionOpenLinks({
      agent: "cursor",
      sessionId: id,
      visibility: "local",
      cwd: "/Users/you/github/joinera",
      transcriptPath: "/tmp/t.jsonl",
    });
    assert.equal(
      links.openUrl,
      `cursor://anysphere.cursor-deeplink/agent?id=${id}`,
    );
    assert.equal(links.viewUrl, "file:///tmp/t.jsonl");
    assert.ok(links.notes.some((n) => /Agents window/i.test(n)));
  });
});

describe("sessionLaunch", () => {
  it("prefers Claude resume command over transcript path", () => {
    const launch = sessionLaunch({
      agent: "claude",
      sessionId: "abc-123",
      visibility: "local",
      cwd: "/Users/you/github/joinera",
      transcriptPath: "/tmp/t.jsonl",
    });
    assert.deepEqual(launch, {
      kind: "command",
      command: "cd /Users/you/github/joinera && claude --resume abc-123",
    });
  });

  it("uses Cursor agent deeplink for local Agent IDs", () => {
    const id = "3b66e79d-cf6f-445a-aa7f-df5094f26b06";
    const launch = sessionLaunch({
      agent: "cursor",
      sessionId: id,
      visibility: "local",
      cwd: "/Users/you/github/joinera",
      transcriptPath: "/tmp/t.jsonl",
    });
    assert.deepEqual(launch, {
      kind: "url",
      url: `cursor://anysphere.cursor-deeplink/agent?id=${id}`,
    });
  });
});
