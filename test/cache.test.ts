import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { emptyScanCache, loadScanCache, saveScanCache } from "../src/local/cache.js";
import { indexClaude } from "../src/local/indexers/claude.js";

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-session-cache-"));
  const project = path.join(root, "-Users-dev-github-demo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, "sess-cache.jsonl"),
    `{"sessionId":"sess-cache","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/Users/dev/github/demo","gitBranch":"main"}\n`,
  );
  return root;
}

describe("scan cache", () => {
  it("reuses cached results for unchanged files", async () => {
    const root = makeTree();
    const cache = emptyScanCache();

    await indexClaude({ projectsRoot: root, cache });
    const file = path.join(root, "-Users-dev-github-demo", "sess-cache.jsonl");
    assert.ok(cache.files[file], "entry cached after first scan");

    // Tamper with the cached result; a cache hit must surface the tampered
    // value, proving the file was not rescanned.
    cache.files[file].result.sessions[0].title = "from-cache";
    const { sessions } = await indexClaude({ projectsRoot: root, cache });
    assert.equal(sessions[0].title, "from-cache");
  });

  it("rescans when mtime or size changes", async () => {
    const root = makeTree();
    const cache = emptyScanCache();
    await indexClaude({ projectsRoot: root, cache });

    const file = path.join(root, "-Users-dev-github-demo", "sess-cache.jsonl");
    cache.files[file].result.sessions[0].title = "stale";
    fs.appendFileSync(
      file,
      `{"sessionId":"sess-cache","timestamp":"2026-08-01T11:00:00.000Z","gitBranch":"feature/y"}\n`,
    );

    const { sessions } = await indexClaude({ projectsRoot: root, cache });
    assert.notEqual(sessions[0].title, "stale");
    assert.equal(sessions[0].branch, "feature/y");
    assert.equal(sessions[0].updatedAt, "2026-08-01T11:00:00.000Z");
  });

  it("prunes entries for deleted files", async () => {
    const root = makeTree();
    const cache = emptyScanCache();
    await indexClaude({ projectsRoot: root, cache });

    const file = path.join(root, "-Users-dev-github-demo", "sess-cache.jsonl");
    fs.rmSync(file);
    const { sessions } = await indexClaude({ projectsRoot: root, cache });
    assert.equal(sessions.length, 0);
    assert.ok(!cache.files[file], "deleted file's entry pruned");
  });

  it("round-trips through disk and tolerates corrupt files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-session-cachefile-"));
    const cachePath = path.join(dir, "cache.json");

    const cache = emptyScanCache();
    saveScanCache(cache, cachePath);
    assert.deepEqual(loadScanCache(cachePath), cache);

    fs.writeFileSync(cachePath, "{ not json");
    assert.deepEqual(loadScanCache(cachePath), emptyScanCache());
  });
});
