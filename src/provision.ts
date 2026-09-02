import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type pg from "pg";
import { databaseUrl, type Config } from "./config.ts";
import {
  connectMaintenance,
  createDatabase,
  databaseExists,
  dropDatabase,
  readMeta,
  templateExists,
  touch,
  writeMeta,
  type Meta,
} from "./db.ts";

class ProvisionError extends Error {}

export type Provisioned = {
  database: string;
  url: string;
  /** True when this call created the database. */
  created: boolean;
};

const RETRY_DELAYS_MS = [200, 500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Connect to the server, running the `ensure` command once if it is not up.
 *
 * dataless does not own the server process: it outlives any single command and
 * is shared by every worktree and every repository on the machine. The manifest
 * says how to start it because only the project knows that.
 */
export async function openServer(config: Config, log: (line: string) => void): Promise<pg.Client> {
  try {
    return await connectMaintenance(config.server);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!config.ensure) {
      throw new ProvisionError(
        `cannot reach ${new URL(config.server).host}: ${reason}. Is the server running?`
      );
    }
    log(`server is not up, running: ${config.ensure}`);
    const started = spawnSync(config.ensure, {
      shell: true,
      stdio: "inherit",
      cwd: config.root,
    });
    if (started.status !== 0) {
      throw new ProvisionError(`"ensure" command failed: ${config.ensure}`);
    }
    for (const delay of RETRY_DELAYS_MS) {
      await sleep(delay);
      try {
        return await connectMaintenance(config.server);
      } catch {
        // keep waiting; the server may still be starting up
      }
    }
    throw new ProvisionError(
      `cannot reach ${new URL(config.server).host} after running "${config.ensure}"`
    );
  }
}

/**
 * Make sure this branch's database exists, and hand back its URL.
 *
 * A database that is created but not set up is worse than none: the app starts
 * against an empty schema and fails in a way that looks like a bug in the app.
 * So a failing setup drops what it created and reports the failure instead.
 */
export async function provision(
  client: pg.Client,
  config: Config,
  database: string,
  branch: string,
  log: (line: string) => void
): Promise<Provisioned> {
  const url = databaseUrl(config, database);
  const env = setupEnv(config, url);

  if (await databaseExists(client, database)) {
    await touch(client, database);
    if (config.setup?.on === "always") runSetup(config, env, log);
    return { database, url, created: false };
  }

  const template =
    config.template && (await templateExists(client, config.template))
      ? config.template
      : undefined;
  if (config.template && !template) {
    log(`template "${config.template}" does not exist yet, creating an empty database`);
  }

  const created = await createDatabase(client, database, template);
  if (!created) {
    // Another worktree won the race. Its setup is running or has run.
    await touch(client, database);
    return { database, url, created: false };
  }

  log(`created ${database}${template ? ` from ${template}` : ""}`);
  const now = new Date().toISOString();
  const meta: Meta = {
    dataless: 1,
    repo: config.root,
    branch,
    createdAt: now,
    lastUsedAt: now,
  };
  await writeMeta(client, database, meta);

  if (config.setup) {
    try {
      runSetup(config, env, log);
    } catch (err) {
      await dropDatabase(client, database, true);
      throw err;
    }
  }

  return { database, url, created: true };
}

/** Drop and provision again: the fastest way back to a known state. */
export async function reset(
  client: pg.Client,
  config: Config,
  database: string,
  branch: string,
  log: (line: string) => void
): Promise<Provisioned> {
  const meta = await readMeta(client, database);
  if (meta === undefined && (await databaseExists(client, database))) {
    throw new ProvisionError(`"${database}" was not created by dataless; refusing to drop it`);
  }
  await dropDatabase(client, database, true);
  return await provision(client, config, database, branch, log);
}

/**
 * The environment a setup command sees.
 *
 * A setup command is a database tool — migrations, a seed — and those read
 * `DATABASE_URL` by convention, so it is always set here even when the manifest
 * exports nothing. It is set rather than defaulted: the hook's job is to
 * prepare *this* database, and a `DATABASE_URL` left over in the shell would
 * otherwise send the migration somewhere else.
 *
 * The wrapped command still gets exactly what `export` says, so a tool like
 * envless stays the place that decides which variable the app reads.
 */
function setupEnv(config: Config, url: string): NodeJS.ProcessEnv {
  return { ...childEnv(config, url), DATABASE_URL: url };
}

function runSetup(config: Config, env: NodeJS.ProcessEnv, log: (line: string) => void): void {
  const setup = config.setup;
  if (!setup) return;
  log(`setup: ${setup.run}`);
  const result = spawnSync(setup.run, { shell: true, stdio: "inherit", cwd: config.root, env });
  if (result.status !== 0) {
    throw new ProvisionError(`setup failed: ${setup.run}`);
  }
}

/** The environment a child sees: the URL, plus any names the manifest exports. */
export function childEnv(config: Config, url: string): NodeJS.ProcessEnv {
  const exported: Record<string, string> = { DATALESS_URL: url };
  for (const name of config.exportAs) exported[name] = url;
  return { ...process.env, ...binPath(config.root), ...exported };
}

/**
 * Put the project's `node_modules/.bin` on PATH, so a setup command or a
 * wrapped command can name a local binary the way an npm script would.
 */
export function binPath(root: string): { PATH?: string } {
  const bin = join(root, "node_modules", ".bin");
  if (!existsSync(bin)) return {};
  const current = process.env["PATH"] ?? "";
  if (current.split(delimiter).includes(bin)) return {};
  return { PATH: current ? `${bin}${delimiter}${current}` : bin };
}

export { ProvisionError };
