import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertServerAllowed,
  ConfigError,
  databaseUrl,
  findConfig,
  parseConfig,
} from "../src/config.ts";

const SERVER = "postgresql://postgres:postgres@localhost:5432";

function parse(body: Record<string, unknown>) {
  return parseConfig("/tmp/dataless.json", JSON.stringify(body));
}

test("parseConfig: the smallest manifest", () => {
  const config = parse({ server: SERVER, database: "myapp" });
  assert.equal(config.server, SERVER);
  assert.equal(config.database, "myapp");
  assert.equal(config.template, undefined);
  assert.equal(config.setup, undefined);
  assert.deepEqual(config.exportAs, []);
  assert.deepEqual(config.params, {});
  assert.equal(config.allowRemote, false);
  assert.equal(config.root, "/tmp");
});

test("parseConfig: setup accepts a string or an object", () => {
  assert.deepEqual(parse({ server: SERVER, database: "myapp", setup: "npm run migrate" }).setup, {
    run: "npm run migrate",
    on: "create",
  });
  assert.deepEqual(
    parse({
      server: SERVER,
      database: "myapp",
      setup: { run: "npm run migrate", on: "always" },
    }).setup,
    { run: "npm run migrate", on: "always" }
  );
  assert.throws(
    () => parse({ server: SERVER, database: "myapp", setup: { run: "x", on: "sometimes" } }),
    ConfigError
  );
});

test("parseConfig: a server naming a database is a mistake, not a default", () => {
  // It would be silently ignored: the database comes from the branch.
  assert.throws(() => parse({ server: `${SERVER}/myapp`, database: "myapp" }), ConfigError);
});

test("parseConfig: rejects what cannot be a database name", () => {
  assert.throws(() => parse({ server: SERVER, database: "My App" }), ConfigError);
  assert.throws(() => parse({ server: SERVER, database: "9lives" }), ConfigError);
  assert.throws(() => parse({ server: SERVER }), ConfigError);
});

test("parseConfig: rejects a server that is not postgres", () => {
  assert.throws(() => parse({ server: "mysql://localhost:3306", database: "myapp" }), ConfigError);
  assert.throws(() => parse({ server: "localhost:5432", database: "myapp" }), ConfigError);
});

test("parseConfig: a template must differ from the prefix", () => {
  assert.throws(
    () => parse({ server: SERVER, database: "myapp", template: "myapp" }),
    ConfigError
  );
});

test("parseConfig: export and params are validated", () => {
  assert.deepEqual(parse({ server: SERVER, database: "myapp", export: "DATABASE_URL" }).exportAs, [
    "DATABASE_URL",
  ]);
  assert.throws(
    () => parse({ server: SERVER, database: "myapp", export: ["not a name"] }),
    ConfigError
  );
  assert.throws(
    () => parse({ server: SERVER, database: "myapp", params: { connection_limit: 5 } }),
    ConfigError
  );
});

test("parseConfig: rejects malformed manifests", () => {
  assert.throws(() => parseConfig("m", "{"), ConfigError);
  assert.throws(() => parseConfig("m", "[]"), ConfigError);
});

test("databaseUrl: names the database and adds the params", () => {
  const config = parse({
    server: SERVER,
    database: "myapp",
    params: { connection_limit: "5" },
  });
  const url = new URL(databaseUrl(config, "myapp_feature_x"));
  assert.equal(url.pathname, "/myapp_feature_x");
  assert.equal(url.searchParams.get("connection_limit"), "5");
});

test("assertServerAllowed: a remote server needs saying twice", () => {
  const local = parse({ server: SERVER, database: "myapp" });
  assertServerAllowed(local, {});

  const remote = parse({ server: "postgresql://db.example.com:5432", database: "myapp" });
  assert.throws(() => assertServerAllowed(remote, {}), ConfigError);
  assert.throws(() => assertServerAllowed(remote, { DATALESS_ALLOW_REMOTE: "1" }), ConfigError);

  const optedIn = parse({
    server: "postgresql://db.example.com:5432",
    database: "myapp",
    allowRemote: true,
  });
  assert.throws(() => assertServerAllowed(optedIn, {}), ConfigError);
  assertServerAllowed(optedIn, { DATALESS_ALLOW_REMOTE: "1" });
});

test("findConfig: walks up from a nested directory", () => {
  const root = mkdtempSync(join(tmpdir(), "dataless-test-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "dataless.json"), "{}");

  assert.equal(findConfig(nested), join(root, "dataless.json"));
});
