import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_NAME = "dataless.json";

/** When to run the setup command. */
export type SetupWhen = "create" | "always";

export type Setup = { run: string; on: SetupWhen };

export type Config = {
  /** Absolute path of the manifest this was parsed from. */
  path: string;
  /** Directory holding the manifest; the project root. */
  root: string;
  /** Server URL without a database, e.g. postgresql://user:pw@localhost:5432 */
  server: string;
  /** Name prefix; the branch slug is appended to it. */
  database: string;
  /** Database to clone from, if any. Nothing may be connected to it. */
  template?: string;
  setup?: Setup;
  /** Extra environment variable names to receive the URL, e.g. DATABASE_URL. */
  exportAs: string[];
  /** Query parameters appended to the URL, e.g. { connection_limit: "5" }. */
  params: Record<string, string>;
  /** Command that starts the server, used once if it cannot be reached. */
  ensure?: string;
  /** Allow a server that is not on this machine. Also needs DATALESS_ALLOW_REMOTE=1. */
  allowRemote: boolean;
};

class ConfigError extends Error {}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/** Walk up from `from` looking for dataless.json. */
export function findConfig(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`"${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  if (obj[key] === undefined) return undefined;
  return requireString(obj, key);
}

function parseSetup(raw: unknown): Setup | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return { run: raw, on: "create" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`"setup" must be a string or an object`);
  }
  const obj = raw as Record<string, unknown>;
  const run = requireString(obj, "run");
  const on = obj["on"] ?? "create";
  if (on !== "create" && on !== "always") {
    throw new ConfigError(`"setup.on" must be "create" or "always"`);
  }
  return { run, on };
}

function parseParams(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`"params" must be an object`);
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new ConfigError(`"params.${key}" must be a string`);
    }
    params[key] = value;
  }
  return params;
}

function parseExport(raw: unknown): string[] {
  if (raw === undefined) return [];
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) {
    throw new ConfigError(`"export" must be a string or an array of strings`);
  }
  return list.map((name) => {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      throw new ConfigError(`"export" contains ${JSON.stringify(name)}, which is not a variable name`);
    }
    return name;
  });
}

export function parseConfig(path: string, text: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(
      `${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigError(`${path}: expected a JSON object at the top level`);
  }
  const obj = json as Record<string, unknown>;

  try {
    const server = requireString(obj, "server");
    let url: URL;
    try {
      url = new URL(server);
    } catch {
      throw new ConfigError(`"server" is not a URL: ${JSON.stringify(server)}`);
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new ConfigError(`"server" must be a postgres:// or postgresql:// URL`);
    }
    // The database comes from the branch, so a path here is a mistake worth
    // catching: it would be silently ignored.
    if (url.pathname !== "" && url.pathname !== "/") {
      throw new ConfigError(
        `"server" must not name a database (${JSON.stringify(url.pathname)}); "database" is the prefix dataless appends the branch to`
      );
    }

    const database = requireString(obj, "database");
    if (!IDENTIFIER.test(database)) {
      throw new ConfigError(
        `"database" must be lowercase letters, digits and underscores: ${JSON.stringify(database)}`
      );
    }
    const template = optionalString(obj, "template");
    if (template !== undefined && !IDENTIFIER.test(template)) {
      throw new ConfigError(
        `"template" must be lowercase letters, digits and underscores: ${JSON.stringify(template)}`
      );
    }
    if (template === database) {
      throw new ConfigError(`"template" must differ from "database"`);
    }

    const allowRemote = obj["allowRemote"] ?? false;
    if (typeof allowRemote !== "boolean") {
      throw new ConfigError(`"allowRemote" must be a boolean`);
    }

    const setup = parseSetup(obj["setup"]);
    const ensure = optionalString(obj, "ensure");

    return {
      path,
      root: dirname(path),
      server,
      database,
      ...(template === undefined ? {} : { template }),
      ...(setup === undefined ? {} : { setup }),
      exportAs: parseExport(obj["export"]),
      params: parseParams(obj["params"]),
      ...(ensure === undefined ? {} : { ensure }),
      allowRemote,
    };
  } catch (err) {
    if (err instanceof ConfigError && !err.message.startsWith(path)) {
      throw new ConfigError(`${path}: ${err.message}`);
    }
    throw err;
  }
}

export function loadConfig(from: string): Config {
  const path = findConfig(from);
  if (!path) {
    throw new ConfigError(`no ${CONFIG_NAME} found (searched from ${resolve(from)} upwards)`);
  }
  return parseConfig(path, readFileSync(path, "utf-8"));
}

/**
 * A server on another machine is refused unless it is asked for twice: once in
 * the manifest and once in the environment. dataless creates and drops
 * databases, and the whole point of the tool is that those are disposable —
 * which is only true of a database on the developer's own machine.
 */
export function assertServerAllowed(config: Config, env: NodeJS.ProcessEnv): void {
  const host = new URL(config.server).hostname;
  if (LOCAL_HOSTS.has(host)) return;
  if (config.allowRemote && env["DATALESS_ALLOW_REMOTE"] === "1") return;
  throw new ConfigError(
    `refusing to manage databases on ${host}: it is not this machine. ` +
      `Set "allowRemote": true in ${CONFIG_NAME} and DATALESS_ALLOW_REMOTE=1 if that is really what you want.`
  );
}

/** URL of one database on the configured server, with the configured params. */
export function databaseUrl(config: Config, database: string): string {
  const url = new URL(config.server);
  url.pathname = `/${database}`;
  for (const [key, value] of Object.entries(config.params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export { ConfigError };
