// Runs review automation in a worktree when the owning session's checkout
// isn't at the PR/MR's head commit: finds or creates a worktree there, checks
// it before the turn, and removes the worktrees Forgekeeper created once their
// PR/MR is over and nothing in them would be lost.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Exec } from './exec';
import {
  checkoutState,
  fetchBranch,
  hasCommit,
  isAncestor,
  isClean,
  listWorktrees,
  localBranch,
  remoteFor,
  type RepositoryLookup,
  type WorktreeEntry,
} from './git';
import { isBusy, linkedOwner, type DirectorySession } from './linked-session';
import { Ineligible } from './review-automation';
import type {
  CheckoutLock,
  createReviewClaims,
  RecordedWorktree,
  WorktreeIntent,
} from './review-claim';

type Claims = ReturnType<typeof createReviewClaims>;

// The source of a PR/MR's commits, and the commit its turn must run at.
export interface WorktreeRequest {
  url: string;
  host: string;
  iid: string;
  sourceProject: string;
  sourceBranch: string;
  headSha: string;
}

// The worktree a turn runs in.
export interface WorktreePlacement {
  directory: string;
  created: boolean;
  // The remote of the source project, for the push command.
  remote?: string;
  // Whether the worktree has a detached HEAD instead of the source branch.
  detached: boolean;
}

export interface WorktreeDependencies {
  exec: Exec;
  claims: Claims;
  projectID: string;
  // The owning session's checkout, whose repository the worktree shares.
  ownerDirectory: string;
  worktree: {
    create: (input: {
      projectID: string;
      branch?: string;
      name?: string;
    }) => Promise<{ directory: string }>;
    list: (input: {
      projectID: string;
    }) => Promise<ReadonlyArray<{ directory: string; strategy?: string }>>;
    remove: (input: { projectID: string; directory: string; force: boolean }) => Promise<void>;
  };
  // Every non-archived session whose directory is the given one, including
  // subagents, whose work in the checkout counts as much as their parent's.
  sessions: (directory: string) => Promise<DirectorySession[]>;
  now: () => number;
}

// How long a recorded creation may take before cleanup looks for what it
// left, and how long a removal may take before another instance retries it.
export const CREATION_TIME = 60 * 60_000;
export const REMOVAL_TIME = 10 * 60_000;

// The name of the worktree Forgekeeper creates for a PR/MR, so later batches
// find it again.
export function worktreeName(request: Pick<WorktreeRequest, 'sourceProject' | 'iid'>) {
  const project = (request.sourceProject.split('/').at(-1) ?? 'project').replace(
    /[^A-Za-z0-9_.-]+/g,
    '-',
  );
  return `forgekeeper-${project}-${request.iid}`;
}

const nameMatches = (directory: string, name: string) =>
  new RegExp(`^${name.replace(/[.]/g, '\\.')}(?:-\\d+)?$`).test(basename(directory));

async function git(run: Exec, directory: string, args: string[]) {
  const result = await run('git', args, directory);
  return result.code === 0;
}

// Finds or creates a worktree at the PR/MR's head commit, and locks it for
// the attempt. Rejects with `Ineligible` when the commit can't be had.
export async function prepareWorktree(
  deps: WorktreeDependencies,
  request: WorktreeRequest,
  holder: CheckoutLock,
): Promise<WorktreePlacement> {
  const { exec, ownerDirectory } = deps;
  const owner = await checkoutState(exec, ownerDirectory);
  const entries = await listWorktrees(exec, ownerDirectory);
  if (!owner || !entries) throw new Error("Could not read the repository's worktrees");
  const remote = await remoteFor(exec, ownerDirectory, {
    host: request.host,
    path: request.sourceProject,
  });
  if (!(await hasCommit(exec, ownerDirectory, request.headSha))) {
    if (!remote)
      throw new Ineligible(
        `The head commit isn't available, and no remote points to ${request.sourceProject} to fetch it from.`,
      );
    await fetchBranch(exec, ownerDirectory, remote, request.sourceBranch);
    if (!(await hasCommit(exec, ownerDirectory, request.headSha)))
      throw new Ineligible(
        `The head commit isn't available, even after fetching ${request.sourceBranch} from ${remote}.`,
      );
  }

  const created = (await deps.claims.worktrees.list()).filter(
    (row): row is RecordedWorktree => row.state === 'ready',
  );
  const ours = (entry: WorktreeEntry) =>
    created.find((row) => row.directory === entry.directory && row.url === request.url);
  const usable = entries.filter(
    (entry) => !entry.unusable && entry.directory !== owner.top && entry.head === request.headSha,
  );
  // Forgekeeper's own worktree for the PR/MR first, even with the changes an
  // earlier batch left, then any other clean one on the branch or detached.
  const candidates = [
    ...usable.filter((entry) => ours(entry)),
    ...usable.filter(
      (entry) => !ours(entry) && (!entry.branch || entry.branch === request.sourceBranch),
    ),
  ];
  for (const entry of candidates) {
    if (!ours(entry) && !(await isClean(exec, entry.directory))) continue;
    if (!(await deps.claims.locks.acquire(entry.directory, holder))) continue;
    if ((await deps.sessions(entry.directory)).some(isBusy)) {
      await deps.claims.locks.release(holder);
      continue;
    }
    return {
      directory: entry.directory,
      created: !!ours(entry),
      ...(remote ? { remote } : {}),
      detached: !entry.branch,
    };
  }
  return createWorktree(deps, request, holder, entries, remote);
}

async function createWorktree(
  deps: WorktreeDependencies,
  request: WorktreeRequest,
  holder: CheckoutLock,
  entries: WorktreeEntry[],
  remote: string | undefined,
): Promise<WorktreePlacement> {
  const { exec, claims, projectID } = deps;
  const name = worktreeName(request);
  const at = deps.now();
  const intent: WorktreeIntent = {
    key: `intent:${name}:${at}`,
    name,
    url: request.url,
    projectID,
    state: 'creating',
    at,
  };
  if (!(await claims.worktrees.save(intent)))
    throw new Error('Another instance is creating this worktree');
  const before = new Set((await deps.worktree.list({ projectID })).map((entry) => entry.directory));
  let directory: string;
  try {
    directory = (await deps.worktree.create({ projectID, branch: request.headSha, name }))
      .directory;
  } catch (error) {
    // A start command can fail after the worktree exists. What appeared
    // under the requested name during the creation is the one it made.
    const after = await deps.worktree.list({ projectID }).catch(() => undefined);
    const left = (after ?? []).filter(
      (entry) =>
        entry.strategy && !before.has(entry.directory) && nameMatches(entry.directory, name),
    );
    if (after)
      await claims.worktrees.replace(
        intent,
        left.map((entry) => ({
          ...intent,
          key: entry.directory,
          directory: entry.directory,
          state: 'ready' as const,
        })),
      );
    throw error;
  }
  await claims.worktrees.replace(intent, [
    { ...intent, key: directory, directory, state: 'ready' },
  ]);
  if (!(await claims.locks.acquire(directory, holder)))
    throw new Error('Another attempt took the new worktree');
  const state = await checkoutState(exec, directory);
  if (state?.head !== request.headSha)
    throw new Error("The new worktree isn't at the PR/MR's head commit");
  const detached = !(await switchToBranch(exec, directory, request, entries, remote));
  return { directory, created: true, ...(remote ? { remote } : {}), detached };
}

// Puts the new, detached worktree on the source branch when that changes no
// branch: the local branch is at the head commit and checked out nowhere, or
// there is none yet. Returns whether it did.
async function switchToBranch(
  exec: Exec,
  directory: string,
  request: WorktreeRequest,
  entries: WorktreeEntry[],
  remote: string | undefined,
): Promise<boolean> {
  const branch = request.sourceBranch;
  if (entries.some((entry) => entry.branch === branch)) return false;
  const local = await localBranch(exec, directory, branch);
  if (local) return local === request.headSha && git(exec, directory, ['switch', branch]);
  if (!remote) return false;
  if (!(await git(exec, directory, ['switch', '--create', branch]))) return false;
  await git(exec, directory, ['config', `branch.${branch}.remote`, remote]);
  await git(exec, directory, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  return true;
}

// Why the worktree can't run the turn now, or undefined when it can: it's at
// the head commit, on the source branch of the source project or detached
// with a remote for it.
export async function worktreeMismatch(
  exec: Exec,
  repository: (directory: string) => Promise<RepositoryLookup>,
  directory: string,
  request: WorktreeRequest,
): Promise<string | undefined> {
  const state = await checkoutState(exec, directory);
  if (!state) return "The worktree isn't a Git checkout anymore";
  if (state.head !== request.headSha) return "The worktree isn't at the PR/MR's head commit";
  if (!state.branch) {
    const remote = await remoteFor(exec, directory, {
      host: request.host,
      path: request.sourceProject,
    });
    return remote ? undefined : `No remote of the worktree points to ${request.sourceProject}`;
  }
  const lookup = await repository(directory);
  if (
    lookup.kind !== 'repository' ||
    lookup.repository.source.host !== request.host ||
    lookup.repository.source.path !== request.sourceProject ||
    lookup.repository.sourceBranch !== request.sourceBranch
  )
    return "The worktree's branch isn't the PR/MR's source branch";
  return undefined;
}

// Whether a session in the directory other than `except`, such as the linked
// session about to run there, is running.
export async function worktreeBusy(
  deps: Pick<WorktreeDependencies, 'sessions'>,
  directory: string,
  except: string,
): Promise<boolean> {
  return (await deps.sessions(directory)).some(
    (session) => session.id !== except && isBusy(session),
  );
}

export interface SweepDependencies extends WorktreeDependencies {
  // The PR/MR, or undefined when it can't be read.
  request: (url: string) => Promise<{ state: string; headSha?: string } | undefined>;
  archive: (sessionID: string) => Promise<void>;
}

// Removes the worktrees Forgekeeper created once their PR/MR merged or
// closed, and nothing in them would be lost: no uncommitted changes, a head
// the PR/MR's final head contains, and no session using it other than
// Forgekeeper's linked ones and their subagents, which it archives. Cleanup
// reserves a worktree before it checks it, which fails while an attempt holds
// it, and keeps any attempt from taking it until the removal ends.
export async function sweepWorktrees(deps: SweepDependencies): Promise<string[]> {
  const { claims, projectID } = deps;
  const removed: string[] = [];
  const rows = (await claims.worktrees.list()).filter((row) => row.projectID === projectID);
  const entries = await listWorktrees(deps.exec, deps.ownerDirectory);
  if (!entries) return removed;
  for (const row of rows) {
    if (row.state === 'creating') {
      await adoptLeftovers(deps, row, rows);
      continue;
    }
    // Another cleanup may still be removing it.
    if (row.state === 'removing' && deps.now() - row.at < REMOVAL_TIME) continue;
    if (!entries.some((entry) => entry.directory === row.directory)) {
      if (row.state === 'removing') await claims.worktrees.completeRemoval(row);
      else await claims.worktrees.remove(row);
      continue;
    }
    const request = await deps.request(row.url).catch(() => undefined);
    if (!request || request.state === 'opened' || !request.headSha) continue;
    const removing = await claims.worktrees.reserveRemoval(row, deps.now());
    if (!removing) continue;
    const linked = await removable(deps, row.directory, request.headSha).catch(() => undefined);
    if (!linked) {
      await claims.worktrees.cancelRemoval(removing);
      continue;
    }
    try {
      // Without force, OpenCode refuses a worktree that changed since.
      await deps.worktree.remove({ projectID, directory: row.directory, force: false });
    } catch {
      await claims.worktrees.cancelRemoval(removing);
      continue;
    }
    await claims.worktrees.completeRemoval(removing);
    for (const session of linked) await deps.archive(session.id).catch(() => {});
    removed.push(row.directory);
  }
  return removed;
}

// The linked root sessions to archive when the worktree can be removed, or
// undefined while it can't.
async function removable(
  deps: SweepDependencies,
  directory: string,
  headSha: string,
): Promise<DirectorySession[] | undefined> {
  const sessions = await deps.sessions(directory);
  if (sessions.some(isBusy) || sessions.some((session) => !linkedTree(session, sessions)))
    return undefined;
  const state = await checkoutState(deps.exec, directory);
  if (
    !state ||
    !(await isAncestor(deps.exec, directory, state.head, headSha)) ||
    !(await isClean(deps.exec, directory))
  )
    return undefined;
  return sessions.filter((session) => !session.parentID);
}

// Whether the session is a linked one or a subagent of one: its root,
// among `sessions`, is linked.
function linkedTree(session: DirectorySession, sessions: readonly DirectorySession[]) {
  const byID = new Map(sessions.map((entry) => [entry.id, entry]));
  let current: DirectorySession | undefined = session;
  for (let depth = 0; current?.parentID && depth < sessions.length; depth++)
    current = byID.get(current.parentID);
  return !!current && !current.parentID && !!linkedOwner(current);
}

// Records the worktree that a creation interrupted by a crash left, if any:
// one OpenCode lists under the requested name, made after the intent.
async function adoptLeftovers(
  deps: SweepDependencies,
  intent: WorktreeIntent,
  rows: readonly (WorktreeIntent | RecordedWorktree)[],
) {
  if (deps.now() - intent.at < CREATION_TIME) return;
  const listed = await deps.worktree.list({ projectID: deps.projectID }).catch(() => undefined);
  if (!listed) return;
  const known = new Set(rows.map((row) => row.directory));
  const left = listed.filter((entry) => {
    if (!entry.strategy || known.has(entry.directory) || !nameMatches(entry.directory, intent.name))
      return false;
    try {
      return statSync(entry.directory).birthtimeMs >= intent.at - 1_000;
    } catch {
      return false;
    }
  });
  await deps.claims.worktrees.replace(
    intent,
    left.map((entry) => ({
      ...intent,
      key: entry.directory,
      directory: entry.directory,
      state: 'ready' as const,
    })),
  );
}
