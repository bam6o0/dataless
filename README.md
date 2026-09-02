# dataless

**Give every git worktree its own Postgres database, created on demand.** One server, one
database per branch, declared in a committed manifest — no per-branch setup, nothing to
copy into a fresh worktree.

[![CI](https://github.com/bam6o0/dataless/actions/workflows/ci.yml/badge.svg)](https://github.com/bam6o0/dataless/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)
![status](https://img.shields.io/badge/status-early-orange.svg)

```bash
npm install -g github:bam6o0/dataless
```

## Why

[portless](https://portless.sh) gives every worktree a stable URL so you never think about
port numbers. [envless](https://github.com/bam6o0/envless) does the same for environment
variables. dataless does it for the development database.

Working on two branches at once usually means sharing one local database between them. The
migration you just wrote is applied for both. The row you inserted to reproduce a bug is
visible in both. Switching branches leaves a schema that matches neither. The usual fixes —
a second container, a second port, a second connection string in a second `.env` — are
per-worktree setup, which is exactly what a worktree is supposed to save you.

A database is cheap: creating one takes a tenth of a second, and copying a small one takes
about the same. dataless leans on that. The server stays shared; the database does not.

## Quick start

Put `dataless.json` at the project root and commit it:

```json
{
  "server": "postgresql://postgres:postgres@localhost:5432",
  "database": "myapp",
  "setup": { "run": "npm run migrate", "on": "always" }
}
```

Run anything through it:

```bash
dataless run npm run dev
```

```
dataless: created myapp_feature_add_widgets
dataless: setup: npm run migrate
dataless: myapp_feature_add_widgets (branch feature/add-widgets)
```

The child process gets `DATALESS_URL`. On the next branch you get another database, with no
change to any file. Git will not let one branch be checked out in two worktrees at once, so
branch names — and therefore database names — are unique without dataless coordinating
anything.

## Manifest reference

| Key | Meaning |
|---|---|
| `server` | The server, **without** a database. Naming one here is an error, since the database comes from the branch |
| `database` | Name prefix. The branch slug is appended: `myapp` → `myapp_feature_add_widgets` |
| `template` | Database to copy, so a new branch starts with data. Optional |
| `setup` | Command to run after creating. `"npm run migrate"`, or `{ "run": …, "on": "create" \| "always" }`. Optional |
| `params` | Query parameters for the URL, e.g. `{ "connection_limit": "5" }`. Optional |
| `export` | Extra variable names that should receive the URL, e.g. `["DATABASE_URL"]`. Optional |
| `ensure` | Command that starts the server, used once if it cannot be reached. Optional |
| `allowRemote` | Permit a server that is not on this machine. See [Safety](#safety) |

Branch names are lowercased and everything outside `[a-z0-9]` becomes `_`. A name too long
for a Postgres identifier (63 bytes) is truncated with a hash of the full branch name on the
end, so two long branches cannot collide.

## CLI reference

```
dataless run <command> [args...]   Run a command against this branch's database
dataless list                      List the databases dataless manages
dataless prune [--yes]             Drop databases whose branch or worktree is gone
dataless drop [<branch>]           Drop one database
dataless reset [<branch>]          Drop and create it again
dataless url [<branch>]            Print the connection URL
```

As far as the terminal is concerned, `dataless run` behaves like the command it wraps: stdio
is inherited, Ctrl-C is forwarded, and the child's exit code becomes dataless's own. The
project's `node_modules/.bin` is added to the child's PATH.

| Option | Applies to |
|---|---|
| `--ephemeral` | `run`: drop the database when the command exits |
| `--force` | `drop`, `reset`: close open connections first |
| `--older-than=DAYS` | `prune`: also drop unused databases older than this (default 14) |
| `--yes` | `prune`: actually drop, instead of listing what would be dropped |

`DATALESS_BRANCH` overrides the branch name, which is how you name a database by hand — in
CI, or outside a git repository.

## Starting with data

An empty database is not always a usable one. With a `template`, a new branch starts as a
copy of a database you prepared:

```json
{
  "server": "postgresql://postgres:postgres@localhost:5432",
  "database": "myapp",
  "template": "myapp_base",
  "setup": { "run": "npm run migrate", "on": "always" }
}
```

Postgres refuses to copy a database that has any other session connected, so **a template
has to be a database nothing runs against**. Keep `myapp_base` as the one nobody opens: seed
it once, and let `setup` bring each copy's schema up to date afterwards. Data comes from the
template, schema freshness from `setup`, and a stale template stops being a problem.

If the template does not exist yet, dataless says so and creates an empty database instead.

A setup command that fails takes the database with it: dataless drops what it created and
reports the failure, rather than leaving your app pointed at half a database.

## With portless and envless

Each tool supplies one value; envless is where they become environment variables:

```bash
portless run dataless run envless run npm run dev
```

```json
{
  "env": {
    "PUBLIC_URL": "{{ portless.url }}",
    "DATABASE_URL": "{{ dataless.url }}"
  }
}
```

envless has to be the innermost of the three, since it reads what the others put in the
environment. Between portless and dataless the order does not matter.

Without envless, name the variable in the manifest instead:

```json
{ "export": ["DATABASE_URL"] }
```

## The connection budget

One shared server has one scarce resource, and it is not disk. A Postgres server defaults to
`max_connections = 100`, while an ORM's default pool is often sized from the CPU count —
Prisma uses `cpus * 2 + 1`, which is 25 on a 12-core machine. Four worktrees running at once
is enough to exhaust the server.

Because dataless composes the URL, one line in the manifest fixes it everywhere:

```json
{ "params": { "connection_limit": "5" } }
```

## Pruning

dataless records the repository and the branch on each database it creates, as a comment on
the database itself. Nothing is written to your working tree, and the record survives
anything that happens to the checkout — which makes cleanup a decision instead of a guess:

```bash
dataless prune          # lists what would go, and why
dataless prune --yes
```

```
would drop myapp_fix_flaky_test  (its branch is gone)
would drop myapp_spike_old_idea  (its worktree is gone)
```

A database with a live connection is never a candidate. Neither is one dataless did not
create: the metadata is the membership test, so a database it knows nothing about is never
listed and never dropped.

## Safety

- A server that is not on this machine is refused unless it is asked for twice: `"allowRemote": true`
  in the manifest **and** `DATALESS_ALLOW_REMOTE=1` in the environment. dataless creates and
  drops databases, and that is only reasonable where they are disposable
- `postgres`, `template0`, `template1`, the configured prefix and the template are never dropped
- `drop` and `reset` refuse a database that was not created by dataless
- `prune` lists by default and needs `--yes` to act

## Design

- **dataless does not manage the server process.** It outlives any one command and is shared
  by every worktree and every repository on the machine, so starting it stays the project's
  job — `ensure` is how the project says how
- **The database is disposable, the server is not.** Everything else follows from that split
- **The manifest declares a resource, not a value.** envless resolves values and never
  creates anything; dataless creates a database and cleans it up. Keeping those two jobs in
  separate tools is why either one is small
- Metadata lives in Postgres, not in a state file — a `dataless.json` in a fresh worktree is
  all the setup there is

## Requirements

Node 24+, and a Postgres server you can create databases on (`CREATEDB`). Tested against
Postgres 14 through 18.
