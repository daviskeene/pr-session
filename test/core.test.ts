import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  branchesMatch,
  buildStamp,
  detectAgentFingerprints,
  extractStampTokens,
  finalizeIndex,
  mapGhPrMeta,
  parsePrRef,
  preferSession,
  resolvePrsForSession,
  resolveSessionsForPr,
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
