import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseName, isDetached, MAX_IDENTIFIER_BYTES, slugify } from "../src/branch.ts";

test("slugify: a branch name becomes an identifier fragment", () => {
  assert.equal(slugify("main"), "main");
  assert.equal(slugify("feature/add-widgets"), "feature_add_widgets");
  assert.equal(slugify("alice/JIRA-123_fix"), "alice_jira_123_fix");
  assert.equal(slugify("release/2.1.0"), "release_2_1_0");
  assert.equal(slugify("--weird--"), "weird");
});

test("databaseName: prefix plus slug", () => {
  assert.equal(databaseName("myapp", "feature/add-widgets"), "myapp_feature_add_widgets");
});

test("databaseName: a long branch is truncated with a hash, not a collision", () => {
  const a = `feature/${"x".repeat(80)}a`;
  const b = `feature/${"x".repeat(80)}b`;
  const nameA = databaseName("myapp", a);
  const nameB = databaseName("myapp", b);

  assert.ok(Buffer.byteLength(nameA) <= MAX_IDENTIFIER_BYTES);
  assert.ok(Buffer.byteLength(nameB) <= MAX_IDENTIFIER_BYTES);
  assert.notEqual(nameA, nameB);
});

test("databaseName: the same branch always gets the same name", () => {
  assert.equal(databaseName("myapp", "feature/x"), databaseName("myapp", "feature/x"));
});

test("isDetached: only names that came from a detached HEAD", () => {
  assert.ok(isDetached("detached_abc1234"));
  assert.ok(!isDetached("main"));
});
