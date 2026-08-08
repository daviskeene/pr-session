import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { indexClaude } from "../src/local/indexers/claude.js";
import { indexCodex } from "../src/local/indexers/codex.js";
import {
  decodeCursorProjectDir,
  indexCursor,
} from "../src/local/indexers/cursor.js";
import { mergeSessions } from "../src/local/store.js";
import type { SessionRecord } from "../src/core/types.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

describe("indexClaude (fixtures)", () => {
  it("indexes sessions, pr-link events, and titles", async () => {
    const { sessions, links } = await indexClaude({
      projectsRoot: path.join(FIXTURES, "claude", "projects"),
    });

    const aaa = sessions.find((s) => s.sessionId === "sess-aaa");
    assert.ok(aaa, "sess-aaa indexed");
    assert.equal(aaa.agent, "claude");
    assert.equal(aaa.cwd, "/Users/dev/github/demo");
    assert.equal(aaa.branch, "feature/login");
    assert.equal(aaa.repo, "demo");
    assert.equal(aaa.title, "Add login flow");
    assert.equal(aaa.startedAt, "2026-08-01T10:00:00.000Z");
    assert.equal(aaa.updatedAt, "2026-08-01T10:15:00.000Z");

    assert.equal(links.length, 1);
    assert.equal(links[0].reason, "pr-link-event");
    assert.equal(links[0].confidence, "exact");
    assert.equal(links[0].pr.owner, "acme");
    assert.equal(links[0].pr.number, 7);
  });

  it("harvests commit SHAs from git-commit stdout", async () => {
    const { sessions } = await indexClaude({
      projectsRoot: path.join(FIXTURES, "claude", "projects"),
    });
    const aaa = sessions.find((s) => s.sessionId === "sess-aaa");
    assert.deepEqual(aaa?.commits, ["abc1234"]);
  });

  it("skips malformed lines without dropping the file", async () => {
    const { sessions } = await indexClaude({
      projectsRoot: path.join(FIXTURES, "claude", "projects"),
    });
    const bbb = sessions.find((s) => s.sessionId === "sess-bbb");
    assert.ok(bbb, "sess-bbb indexed despite bad first line");
    assert.equal(bbb.cwd, "/Users/dev/github/other");
    assert.equal(bbb.repo, "other");
  });
});

describe("indexCodex (fixtures)", () => {
  it("indexes session_meta and PR URL mentions", async () => {
    const { sessions, links } = await indexCodex({
      sessionsRoot: path.join(FIXTURES, "codex", "sessions"),
      archivedRoot: path.join(FIXTURES, "codex", "archived"),
    });

    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.sessionId, "018f0000-0000-7000-8000-000000000001");
    assert.equal(s.cwd, "/Users/dev/github/demo");
    assert.equal(s.branch, "feature/login");
    assert.equal(s.repo, "acme/demo");
    assert.deepEqual(s.commits, [
      "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
    ]);

    assert.equal(links.length, 1);
    assert.equal(links[0].reason, "transcript-mention");
    assert.equal(links[0].pr.number, 7);
  });

  it("does not let a sparse archived copy clobber session metadata", async () => {
    // Regression: the archived mirror lacks session_meta; merging it must not
    // wipe branch/repo/cwd, and the time range must span both copies.
    const { sessions } = await indexCodex({
      sessionsRoot: path.join(FIXTURES, "codex", "sessions"),
      archivedRoot: path.join(FIXTURES, "codex", "archived"),
    });
    const s = sessions[0];
    assert.equal(s.branch, "feature/login");
    assert.equal(s.repo, "acme/demo");
    assert.equal(s.cwd, "/Users/dev/github/demo");
    assert.equal(s.startedAt, "2026-08-01T10:00:00.000Z");
    assert.equal(s.updatedAt, "2026-08-01T11:00:00.000Z");
  });
});

describe("indexCursor (fixtures)", () => {
  it("decodes project dirs and extracts PR mentions", async () => {
    const { sessions, links } = await indexCursor({
      projectsRoot: path.join(FIXTURES, "cursor", "projects"),
    });

    const s = sessions.find(
      (x) => x.sessionId === "3b66e79d-cf6f-445a-aa7f-df5094f26b06",
    );
    assert.ok(s, "cursor session indexed");
    assert.equal(s.cwd, "/Users/dev/github/demo");
    assert.equal(s.repo, "demo");
    assert.equal(s.title, "Fix the login bug please");
    assert.ok(s.startedAt, "startedAt from file stat");

    assert.equal(links.length, 1);
    assert.equal(links[0].pr.number, 9);
    assert.equal(links[0].reason, "transcript-mention");
  });

  it("skips empty-window housekeeping projects", async () => {
    const { sessions } = await indexCursor({
      projectsRoot: path.join(FIXTURES, "cursor", "projects"),
    });
    assert.ok(
      !sessions.some(
        (s) => s.sessionId === "99999999-9999-4999-8999-999999999999",
      ),
      "empty-window session must not be indexed",
    );
  });
});

describe("decodeCursorProjectDir", () => {
  it("decodes Users-<user>-github-<repo> names", () => {
    assert.deepEqual(decodeCursorProjectDir("Users-dev-github-demo"), {
      cwdGuess: "/Users/dev/github/demo",
      repoGuess: "demo",
    });
  });

  it("restores a dotted username from its first dash", () => {
    assert.deepEqual(
      decodeCursorProjectDir("Users-davis-keene-github-joinera"),
      {
        cwdGuess: "/Users/davis.keene/github/joinera",
        repoGuess: "joinera",
      },
    );
  });

  it("returns nothing for dot-dirs and repo-only guess otherwise", () => {
    assert.deepEqual(decodeCursorProjectDir(".agent-data-cleanup"), {});
    assert.deepEqual(decodeCursorProjectDir("scratch"), {
      repoGuess: "scratch",
    });
  });
});

describe("mergeSessions", () => {
  const base: SessionRecord = {
    agent: "codex",
    sessionId: "x",
    visibility: "local",
    transcriptPath: "/tmp/a.jsonl",
    cwd: "/Users/dev/github/demo",
    repo: "acme/demo",
    branch: "feature/x",
    startedAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:20:00.000Z",
  };

  it("never lets undefined clobber defined fields", () => {
    const sparse: SessionRecord = {
      agent: "codex",
      sessionId: "x",
      visibility: "local",
      transcriptPath: "/tmp/b.jsonl",
      cwd: undefined,
      repo: undefined,
      branch: undefined,
      updatedAt: "2026-08-01T11:00:00.000Z",
    };
    const merged = mergeSessions(base, sparse);
    assert.equal(merged.branch, "feature/x");
    assert.equal(merged.repo, "acme/demo");
    assert.equal(merged.cwd, "/Users/dev/github/demo");
  });

  it("spans the union of both time ranges", () => {
    const later: SessionRecord = {
      agent: "codex",
      sessionId: "x",
      visibility: "local",
      startedAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    const merged = mergeSessions(base, later);
    assert.equal(merged.startedAt, "2026-08-01T09:00:00.000Z");
    assert.equal(merged.updatedAt, "2026-08-01T12:00:00.000Z");
  });

  it("keeps cloud visibility and url from either copy", () => {
    const cloud: SessionRecord = {
      agent: "cursor",
      sessionId: "y",
      visibility: "cloud",
      cloudUrl: "https://cursor.com/agents/bc-1",
    };
    const local: SessionRecord = {
      agent: "cursor",
      sessionId: "y",
      visibility: "local",
      transcriptPath: "/tmp/y.jsonl",
      repo: "acme/demo",
      cwd: "/Users/dev/github/demo",
      branch: "main",
      title: "t",
    };
    const merged = mergeSessions(cloud, local);
    assert.equal(merged.visibility, "cloud");
    assert.equal(merged.cloudUrl, "https://cursor.com/agents/bc-1");
    assert.equal(merged.repo, "acme/demo");
  });
});
