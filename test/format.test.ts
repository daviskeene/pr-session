import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatLinkRows,
  formatWhen,
  parsePickerAnswer,
} from "../src/cli/format.js";
import type { LinkRecord } from "../src/core/types.js";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function link(overrides: {
  sessionId: string;
  confidence: LinkRecord["confidence"];
  branch?: string;
  updatedAt?: string;
  title?: string;
}): LinkRecord {
  return {
    pr: {
      owner: "acme",
      repo: "demo",
      number: 71,
      url: "https://github.com/acme/demo/pull/71",
    },
    session: {
      agent: "claude",
      sessionId: overrides.sessionId,
      visibility: "local",
      branch: overrides.branch,
      updatedAt: overrides.updatedAt,
      title: overrides.title,
    },
    confidence: overrides.confidence,
    reason: "pr-link-event",
  };
}

describe("formatLinkRows", () => {
  const links = [
    link({
      sessionId: "b0d48547-882c-4b82-8271-f7893ab0b465",
      confidence: "exact",
      branch: "main",
      updatedAt: "2026-08-07T22:00:00.000Z",
      title: "bell UI + preferences polish",
    }),
    link({
      sessionId: "019f8676-a907-7b63-8acb-8c72dd53128e",
      confidence: "high",
      branch: "feat/in-app-notifications",
      updatedAt: "2026-07-21T16:55:00.000Z",
    }),
  ];

  it("renders numbered aligned rows with short ids and dates", () => {
    const out = formatLinkRows(links, { now: NOW });
    const lines = out.split("\n");
    assert.match(lines[0], /^ {2}1 {2}exact {2}claude:b0d48547 {2}/);
    assert.match(lines[0], /main\s+/);
    assert.match(lines[0], /Aug 7$/);
    assert.match(lines[1], /^ {5}"bell UI \+ preferences polish"$/);
    assert.match(lines[2], /^ {2}2 {2}high {3}claude:019f8676 {2}/);
    assert.match(lines[2], /feat\/in-app-notifications/);
    assert.match(lines[2], /Jul 21$/);
  });

  it("emits no ANSI codes unless color is requested", () => {
    assert.doesNotMatch(formatLinkRows(links, { now: NOW }), /\x1b\[/);
    assert.match(
      formatLinkRows(links, { now: NOW, color: true }),
      /\x1b\[32m/,
    );
  });
});

describe("formatWhen", () => {
  it("shows month+day this year, month+year otherwise", () => {
    assert.equal(formatWhen("2026-08-07T22:00:00.000Z", NOW), "Aug 7");
    assert.equal(formatWhen("2025-12-31T00:00:00.000Z", NOW), "Dec 2025");
    assert.equal(formatWhen(undefined, NOW), "");
    assert.equal(formatWhen("garbage", NOW), "");
  });
});

describe("parsePickerAnswer", () => {
  it("accepts in-range numbers and skips everything else", () => {
    assert.equal(parsePickerAnswer("2", 3), 2);
    assert.equal(parsePickerAnswer(" 3 ", 3), 3);
    assert.equal(parsePickerAnswer("", 3), null);
    assert.equal(parsePickerAnswer("0", 3), null);
    assert.equal(parsePickerAnswer("4", 3), null);
    assert.equal(parsePickerAnswer("q", 3), null);
    assert.equal(parsePickerAnswer("1.5", 3), null);
  });
});
