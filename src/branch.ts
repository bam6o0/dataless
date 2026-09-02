import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Postgres truncates identifiers at 63 bytes, so a name has to fit. */
export const MAX_IDENTIFIER_BYTES = 63;

class BranchError extends Error {}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The branch this checkout is on. Git refuses to have one branch checked out in
 * two worktrees at once, so branch names — and therefore database names — are
 * unique across every worktree of a repository without dataless coordinating
 * anything.
 */
export function currentBranch(cwd: string, env: NodeJS.ProcessEnv): string {
  const override = env["DATALESS_BRANCH"];
  if (override) return override;

  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) {
    throw new BranchError(
      `${cwd} is not a git repository (set DATALESS_BRANCH to name the database yourself)`
    );
  }
  // A detached HEAD has no branch name; the commit is the next best identity.
  if (branch === "HEAD") {
    const sha = git(cwd, ["rev-parse", "--short=7", "HEAD"]);
    return `detached_${sha ?? "unknown"}`;
  }
  return branch;
}

/** Whether a name came from a detached HEAD rather than a branch. */
export function isDetached(branch: string): boolean {
  return branch.startsWith("detached_");
}

/** A branch name as a Postgres identifier fragment: lowercase, underscores. */
export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * `<prefix>_<slug>`, shortened to fit an identifier. Truncation could make two
 * long branch names collide, so a hash of the full name goes on the end.
 */
export function databaseName(prefix: string, branch: string): string {
  const slug = slugify(branch);
  const full = `${prefix}_${slug}`;
  if (Buffer.byteLength(full) <= MAX_IDENTIFIER_BYTES) return full;

  const digest = createHash("sha256").update(branch).digest("hex").slice(0, 6);
  const room = MAX_IDENTIFIER_BYTES - Buffer.byteLength(`${prefix}__${digest}`);
  if (room <= 0) {
    throw new BranchError(
      `"${prefix}" leaves no room for a branch name within ${MAX_IDENTIFIER_BYTES} bytes`
    );
  }
  return `${prefix}_${slug.slice(0, room)}_${digest}`;
}

/** Whether `branch` still exists in the repository at `repo`. */
export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
}

export { BranchError };
