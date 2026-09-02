import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry } from "../src/db.ts";
import { selectPrunable, type PruneInput } from "../src/prune.ts";

const NOW = new Date("2026-09-02T00:00:00Z");

function entry(over: Partial<Entry> & { branch?: string; repo?: string; lastUsedAt?: string }): Entry {
  return {
    database: over.database ?? "myapp_feature_x",
    sizeBytes: over.sizeBytes ?? 1024,
    connections: over.connections ?? 0,
    meta: {
      dataless: 1,
      repo: over.repo ?? "/repo",
      branch: over.branch ?? "feature/x",
      createdAt: "2026-09-01T00:00:00Z",
      lastUsedAt: over.lastUsedAt ?? "2026-09-01T00:00:00Z",
    },
  };
}

function input(entries: Entry[], over: Partial<PruneInput> = {}): PruneInput {
  return {
    entries,
    now: NOW,
    olderThanDays: 14,
    protectedNames: new Set(["myapp", "myapp_base"]),
    repoExists: () => true,
    branchExists: () => true,
    isDetached: (branch) => branch.startsWith("detached_"),
    ...over,
  };
}

test("keeps a database whose branch and worktree are both alive", () => {
  assert.deepEqual(selectPrunable(input([entry({})])), []);
});

test("drops a database whose worktree is gone", () => {
  const candidates = selectPrunable(input([entry({})], { repoExists: () => false }));
  assert.deepEqual(
    candidates.map((c) => c.reason),
    ["repo-gone"]
  );
});

test("drops a database whose branch was deleted after a merge", () => {
  const candidates = selectPrunable(input([entry({})], { branchExists: () => false }));
  assert.deepEqual(
    candidates.map((c) => c.reason),
    ["branch-gone"]
  );
});

test("a detached HEAD has no branch to delete, so it only goes stale", () => {
  const detached = entry({ branch: "detached_abc1234", database: "myapp_detached_abc1234" });
  assert.deepEqual(selectPrunable(input([detached], { branchExists: () => false })), []);

  const old = entry({
    branch: "detached_abc1234",
    database: "myapp_detached_abc1234",
    lastUsedAt: "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(
    selectPrunable(input([old], { branchExists: () => false })).map((c) => c.reason),
    ["stale"]
  );
});

test("never touches a protected name, even if its owner is gone", () => {
  const base = entry({ database: "myapp_base", branch: "main" });
  assert.deepEqual(selectPrunable(input([base], { repoExists: () => false })), []);
});

test("never touches a database something is connected to", () => {
  const busy = entry({ connections: 1 });
  assert.deepEqual(selectPrunable(input([busy], { repoExists: () => false })), []);
});

test("staleness is measured from last use", () => {
  const old = entry({ lastUsedAt: "2026-08-01T00:00:00Z" });
  assert.deepEqual(
    selectPrunable(input([old])).map((c) => c.reason),
    ["stale"]
  );
  assert.deepEqual(selectPrunable(input([old], { olderThanDays: 60 })), []);
});
