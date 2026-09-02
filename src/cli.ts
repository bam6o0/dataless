#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type pg from "pg";
import {
  assertServerAllowed,
  ConfigError,
  databaseUrl,
  loadConfig,
  type Config,
} from "./config.ts";
import {
  branchExists,
  BranchError,
  currentBranch,
  databaseName,
  isDetached,
} from "./branch.ts";
import { DatabaseError, dropDatabase, listManaged, readMeta } from "./db.ts";
import {
  childEnv,
  openServer,
  provision,
  ProvisionError,
  reset,
} from "./provision.ts";
import { explain, selectPrunable } from "./prune.ts";

const USAGE = `dataless - a Postgres database per git worktree, created on demand

Usage:
  dataless run <command> [args...]   Run a command against this branch's database
  dataless list                      List the databases dataless manages
  dataless prune [--yes]             Drop databases whose branch or worktree is gone
  dataless drop [<branch>]           Drop one database
  dataless reset [<branch>]          Drop and create it again
  dataless url [<branch>]            Print the connection URL

Options:
  --ephemeral         run: drop the database when the command exits
  --force             drop/reset: close open connections first
  --older-than=DAYS   prune: also drop unused databases older than this (default 14)
  --yes               prune: actually drop, instead of listing what would be dropped
  -h, --help          Show this help
  -v, --version       Show the version

Manifest (dataless.json, found by walking up from the working directory):
  {
    "server": "postgresql://postgres:postgres@localhost:5432",
    "database": "myapp",
    "template": "myapp_base",
    "setup": { "run": "npm run migrate", "on": "always" },
    "params": { "connection_limit": "5" },
    "export": ["DATABASE_URL"],
    "ensure": "docker compose up -d postgres"
  }

  server      the server, without a database
  database    name prefix; the branch slug is appended to it
  template    database to copy, so a new branch starts with data (optional)
  setup       command to run after creating, "on": "create" or "always" (optional).
              It always sees DATABASE_URL, whatever "export" says
  params      query parameters for the URL, e.g. a connection limit (optional)
  export      extra variable names to receive the URL (optional)
  ensure      command that starts the server, used if it is not up (optional)

The URL is passed to the child process as DATALESS_URL. With envless, name it
where it belongs instead:

  {
    "env": { "DATABASE_URL": "{{ dataless.url }}" }
  }

  dataless run envless run npm run dev

dataless does not manage the server process. It outlives any one command and is
shared by every worktree on the machine, so starting it stays the project's job.
`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };
  return pkg.version;
}

/** stderr, so a wrapped command's stdout stays clean for pipes. */
function log(line: string): void {
  console.error(`dataless: ${line}`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

type Context = {
  config: Config;
  branch: string;
  database: string;
};

function context(branchOverride?: string): Context {
  const config = loadConfig(process.cwd());
  assertServerAllowed(config, process.env);
  const branch = branchOverride ?? currentBranch(config.root, process.env);
  return { config, branch, database: databaseName(config.database, branch) };
}

/** Databases dataless must never drop, whatever their metadata says. */
function protectedNames(config: Config): Set<string> {
  const names = new Set<string>([config.database, "postgres", "template0", "template1"]);
  if (config.template) names.add(config.template);
  return names;
}

async function withServer<T>(config: Config, body: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await openServer(config, log);
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

async function cmdRun(argv: string[]): Promise<number> {
  const ephemeral = argv.includes("--ephemeral");
  const rest = argv.filter((arg) => arg !== "--ephemeral");
  const [command, ...args] = rest;
  if (!command) {
    console.error("dataless: run needs a command\n");
    console.error(USAGE);
    return 1;
  }

  const { config, branch, database } = context();
  const provisioned = await withServer(config, (client) =>
    provision(client, config, database, branch, log)
  );
  log(`${database} (branch ${branch})`);

  const child = spawn(command, args, {
    stdio: "inherit",
    env: childEnv(config, provisioned.url),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  const code = await new Promise<number>((done, fail) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(`dataless: command not found: ${command}`);
        done(127);
        return;
      }
      fail(err);
    });
    // A child killed by a signal has no exit code; report it as a failure.
    child.on("exit", (status, signal) => done(signal ? 1 : (status ?? 0)));
  });

  if (ephemeral) {
    await withServer(config, async (client) => {
      await dropDatabase(client, database, true);
      log(`dropped ${database}`);
    });
  }
  return code;
}

async function cmdList(): Promise<number> {
  const { config, database } = context();
  const entries = await withServer(config, (client) => listManaged(client, config.database));
  if (entries.length === 0) {
    log(`no databases yet (this branch would use ${database})`);
    return 0;
  }
  const width = Math.max(...entries.map((entry) => entry.database.length));
  for (const entry of entries) {
    const here = entry.database === database ? "*" : " ";
    const busy = entry.connections > 0 ? `${entry.connections} conn` : "idle";
    console.log(
      `${here} ${entry.database.padEnd(width)}  ${formatSize(entry.sizeBytes).padStart(9)}  ${busy.padEnd(7)}  ${entry.meta.lastUsedAt.slice(0, 19)}  ${entry.meta.branch}`
    );
  }
  return 0;
}

async function cmdPrune(argv: string[]): Promise<number> {
  const apply = argv.includes("--yes");
  const olderThan = Number(
    argv.find((arg) => arg.startsWith("--older-than"))?.split("=")[1] ?? 14
  );
  if (!Number.isFinite(olderThan) || olderThan < 0) {
    console.error("dataless: --older-than needs a number of days");
    return 1;
  }

  const { config } = context();
  return await withServer(config, async (client) => {
    const entries = await listManaged(client, config.database);
    const candidates = selectPrunable({
      entries,
      now: new Date(),
      olderThanDays: olderThan,
      protectedNames: protectedNames(config),
      repoExists: existsSync,
      branchExists,
      isDetached,
    });

    if (candidates.length === 0) {
      log("nothing to prune");
      return 0;
    }
    for (const { entry, reason } of candidates) {
      const why = explain(reason, olderThan);
      if (!apply) {
        console.log(`would drop ${entry.database}  (${why})`);
        continue;
      }
      await dropDatabase(client, entry.database, false);
      console.log(`dropped ${entry.database}  (${why})`);
    }
    if (!apply) log(`${candidates.length} to drop; pass --yes to do it`);
    const busy = entries.filter((entry) => entry.connections > 0).length;
    if (busy > 0) log(`${busy} database(s) skipped because something is connected`);
    return 0;
  });
}

async function cmdDrop(argv: string[]): Promise<number> {
  const force = argv.includes("--force");
  const branchArg = argv.find((arg) => !arg.startsWith("-"));
  const { config, database } = context(branchArg);
  return await withServer(config, async (client) => {
    const meta = await readMeta(client, database);
    if (!meta) {
      log(`${database} is not a database dataless created; leaving it alone`);
      return 1;
    }
    await dropDatabase(client, database, force);
    log(`dropped ${database}`);
    return 0;
  });
}

async function cmdReset(argv: string[]): Promise<number> {
  const branchArg = argv.find((arg) => !arg.startsWith("-"));
  const { config, branch, database } = context(branchArg);
  await withServer(config, (client) => reset(client, config, database, branch, log));
  log(`reset ${database}`);
  return 0;
}

function cmdUrl(argv: string[]): number {
  const branchArg = argv.find((arg) => !arg.startsWith("-"));
  const { config, database } = context(branchArg);
  // Unlike a secret, a local development connection string is meant to be
  // pasted into psql, so this prints it.
  console.log(databaseUrl(config, database));
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "-h" || first === "--help" || first === "help") {
    console.log(USAGE);
    return first ? 0 : 1;
  }
  if (first === "-v" || first === "--version") {
    console.log(version());
    return 0;
  }

  const rest = argv.slice(1);
  switch (first) {
    case "run":
      return await cmdRun(rest);
    case "list":
      return await cmdList();
    case "prune":
      return await cmdPrune(rest);
    case "drop":
      return await cmdDrop(rest);
    case "reset":
      return await cmdReset(rest);
    case "url":
      return cmdUrl(rest);
  }

  console.error(`dataless: unknown command ${JSON.stringify(first)}\n`);
  console.error(USAGE);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (
      err instanceof ConfigError ||
      err instanceof BranchError ||
      err instanceof DatabaseError ||
      err instanceof ProvisionError
    ) {
      console.error(`dataless: ${err.message}`);
    } else {
      console.error("dataless:", err);
    }
    process.exit(1);
  });