import type { Entry } from "./db.ts";

export type PruneReason = "repo-gone" | "branch-gone" | "stale";

export type Candidate = { entry: Entry; reason: PruneReason };

export type PruneInput = {
  entries: Entry[];
  now: Date;
  olderThanDays: number;
  /** Names that are never candidates, whatever their metadata says. */
  protectedNames: Set<string>;
  repoExists: (path: string) => boolean;
  branchExists: (repo: string, branch: string) => boolean;
  isDetached: (branch: string) => boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which databases are no longer anybody's.
 *
 * The metadata records the repository and the branch, so this is a decision
 * rather than a guess: a database whose branch was deleted after a merge, or
 * whose worktree was removed, has no owner left. Everything else is only a
 * candidate once it has gone unused for a while, and a database with a live
 * connection is never one.
 */
export function selectPrunable(input: PruneInput): Candidate[] {
  const candidates: Candidate[] = [];
  const staleBefore = input.now.getTime() - input.olderThanDays * DAY_MS;

  for (const entry of input.entries) {
    if (input.protectedNames.has(entry.database)) continue;
    if (entry.connections > 0) continue;

    if (!input.repoExists(entry.meta.repo)) {
      candidates.push({ entry, reason: "repo-gone" });
      continue;
    }
    // A detached HEAD never had a branch to delete, so it can only go stale.
    if (
      !input.isDetached(entry.meta.branch) &&
      !input.branchExists(entry.meta.repo, entry.meta.branch)
    ) {
      candidates.push({ entry, reason: "branch-gone" });
      continue;
    }
    const lastUsed = Date.parse(entry.meta.lastUsedAt);
    if (Number.isFinite(lastUsed) && lastUsed < staleBefore) {
      candidates.push({ entry, reason: "stale" });
    }
  }

  return candidates;
}

export function explain(reason: PruneReason, olderThanDays: number): string {
  switch (reason) {
    case "repo-gone":
      return "its worktree is gone";
    case "branch-gone":
      return "its branch is gone";
    case "stale":
      return `unused for more than ${olderThanDays} days`;
  }
}
