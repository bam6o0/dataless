import pg from "pg";

/** What dataless records on a database it created, as a COMMENT. */
export type Meta = {
  dataless: 1;
  repo: string;
  branch: string;
  createdAt: string;
  lastUsedAt: string;
};

export type Entry = {
  database: string;
  meta: Meta;
  sizeBytes: number;
  connections: number;
};

class DatabaseError extends Error {}

/** Connecting to a database that does not exist. */
const UNDEFINED_DATABASE = "3D000";
/** Two worktrees starting at once; whoever lost the race just carries on. */
const DUPLICATE_DATABASE = "42P04";

function code(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A client on the maintenance database. CREATE/DROP DATABASE cannot run from
 * inside the database they operate on, so every management statement goes
 * through this connection rather than the app's.
 */
export async function connectMaintenance(server: string): Promise<pg.Client> {
  const url = new URL(server);
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

export async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    "select 1 as one from pg_database where datname = $1",
    [name]
  );
  return rows.length > 0;
}

/**
 * Create `name`, optionally as a copy of `template`.
 *
 * Postgres refuses to copy a database that has any other session connected, so
 * a template has to be a database nothing runs against. Returns false if the
 * database already existed.
 */
export async function createDatabase(
  client: pg.Client,
  name: string,
  template?: string
): Promise<boolean> {
  const from = template ? ` TEMPLATE ${quoteIdent(template)}` : "";
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(name)}${from}`);
    return true;
  } catch (err) {
    if (code(err) === DUPLICATE_DATABASE) return false;
    if (template && err instanceof Error && /being accessed by other users/.test(err.message)) {
      throw new DatabaseError(
        `cannot copy "${template}": something is connected to it. ` +
          `A template has to be a database nothing runs against.`
      );
    }
    throw err;
  }
}

export async function templateExists(client: pg.Client, template: string): Promise<boolean> {
  return await databaseExists(client, template);
}

/** COMMENT takes a literal, not a parameter, so the JSON is quoted by hand. */
export async function writeMeta(client: pg.Client, name: string, meta: Meta): Promise<void> {
  await client.query(
    `COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(JSON.stringify(meta))}`
  );
}

export async function readMeta(client: pg.Client, name: string): Promise<Meta | undefined> {
  const { rows } = await client.query<{ comment: string | null }>(
    `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
    [name]
  );
  return parseMeta(rows[0]?.comment ?? null);
}

export async function touch(client: pg.Client, name: string): Promise<void> {
  const meta = await readMeta(client, name);
  if (!meta) return;
  await writeMeta(client, name, { ...meta, lastUsedAt: new Date().toISOString() });
}

function parseMeta(comment: string | null): Meta | undefined {
  if (!comment) return undefined;
  try {
    const parsed = JSON.parse(comment) as Partial<Meta>;
    if (parsed.dataless !== 1 || typeof parsed.branch !== "string" || typeof parsed.repo !== "string") {
      return undefined;
    }
    return {
      dataless: 1,
      repo: parsed.repo,
      branch: parsed.branch,
      createdAt: parsed.createdAt ?? "",
      lastUsedAt: parsed.lastUsedAt ?? parsed.createdAt ?? "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Every database dataless created, newest use first.
 *
 * The metadata comment is the membership test: a database without it is
 * somebody else's and is never listed, never dropped.
 */
export async function listManaged(client: pg.Client, prefix?: string): Promise<Entry[]> {
  const { rows } = await client.query<{
    datname: string;
    comment: string | null;
    size_bytes: string;
    connections: string;
  }>(
    `select d.datname,
            shobj_description(d.oid, 'pg_database') as comment,
            pg_database_size(d.datname)::text as size_bytes,
            (select count(*) from pg_stat_activity a where a.datname = d.datname)::text as connections
       from pg_database d
      where not d.datistemplate
        and shobj_description(d.oid, 'pg_database') like '%"dataless"%'
      order by d.datname`
  );

  const entries: Entry[] = [];
  for (const row of rows) {
    const meta = parseMeta(row.comment);
    if (!meta) continue;
    if (prefix && !row.datname.startsWith(`${prefix}_`)) continue;
    entries.push({
      database: row.datname,
      meta,
      sizeBytes: Number(row.size_bytes),
      connections: Number(row.connections),
    });
  }
  return entries.sort((a, b) => b.meta.lastUsedAt.localeCompare(a.meta.lastUsedAt));
}

/** Close every other session on a database. Returns how many were closed. */
export async function terminate(client: pg.Client, name: string): Promise<number> {
  const { rows } = await client.query<{ closed: string }>(
    `select count(*)::text as closed
       from (select pg_terminate_backend(pid)
               from pg_stat_activity
              where datname = $1 and pid <> pg_backend_pid()) t`,
    [name]
  );
  return Number(rows[0]?.closed ?? 0);
}

/**
 * Drop a database. `force` closes sessions first — a dev server that crashed
 * can leave a connection behind, and DROP DATABASE refuses while one is open.
 */
export async function dropDatabase(
  client: pg.Client,
  name: string,
  force = false
): Promise<void> {
  if (force) await terminate(client, name);
  try {
    await client.query(`DROP DATABASE ${quoteIdent(name)}`);
  } catch (err) {
    if (code(err) === UNDEFINED_DATABASE) return;
    if (!force && err instanceof Error && /being accessed by other users/.test(err.message)) {
      throw new DatabaseError(
        `"${name}" is in use. Stop what is connected, or pass --force to close it.`
      );
    }
    throw err;
  }
}

export { DatabaseError, UNDEFINED_DATABASE, quoteIdent, quoteLiteral, parseMeta };
