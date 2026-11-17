// Runs review automation in a worktree when the owning session's checkout
// isn't at the PR/MR's head commit: finds or creates a worktree there, checks
// it before the turn, and removes the worktrees Forgekeeper created once their
// PR/MR is over and nothing in them would be lost.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
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
  // Every non-archived session in the checkout, in its directory or below
  // it, including subagents, whose work in the checkout counts as much as
  // their parent's. Rejects when they can't all be read.
  sessions: (directory: string) => Promise<DirectorySession[]>;
  // The checkout's branch and the source it pushes to.
  repository: (directory: string) => Promise<RepositoryLookup>;
  now: () => number;
}

// How long a recorded creation may take before cleanup looks for what it
// left, and how long a removal may take before another instance retries it.
export const CREATION_TIME = 60 * 60_000;
export const REMOVAL_TIME = 10 * 60_000;

// The name of the worktree Forgekeeper creates for a PR/MR. Its prefix
// names the PR/MR, and `creation`, random for each creation, sets it apart,
// so what a failed creation left is never confused with another worktree.
export function worktreeName(
  request: Pick<WorktreeRequest, 'sourceProject' | 'iid'>,
  creation: string,
) {
  const project = (request.sourceProject.split('/').at(-1) ?? 'project').replace(
    /[^A-Za-z0-9_.-]+/g,
    '-',
  );
  return `forgekeeper-${project}-${request.iid}-${creation}`;
}

// Whether OpenCode created the directory for the requested name, which it
// suffixes with a number when the directory exists.
const nameMatches = (directory: string, name: string) =>
  new RegExp(`^${name.replace(/[.]/g, '\\.')}(?:-\\d+)?$`).test(basename(directory));

// The path with symbolic links resolved, or as given when it doesn't exist.
function canonical(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

// Whether a session at `location` works in the checkout at `root`: its
// directory is the checkout's or below it, but not in another checkout of
// the repository nested there. Both the paths as given and with symbolic
// links resolved count, so an alias never hides a session.
export function inCheckout(location: string, root: string, checkouts: readonly string[]) {
  const forms = (path: string) => [...new Set([resolve(path), canonical(path)])];
  const roots = forms(root);
  const nested = checkouts
    .flatMap(forms)
    .filter((other) => roots.some((path) => other !== path && within(other, path)));
  return forms(location).some(
    (path) =>
      roots.some((root) => within(path, root)) && !nested.some((other) => within(path, other)),
  );
}

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
    created.some((row) => row.directory === entry.directory && row.url === request.url);
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
    if (!(await deps.claims.locks.acquire(entry.directory, holder))) continue;
    // Checked while the attempt holds the worktree, so no other attempt
    // changes it in between: its branch pushes to the source branch of the
    // source project, and no one else uses it or left changes there.
    const refusal =
      (await worktreeMismatch(exec, deps.repository, entry.directory, request)) ??
      (await worktreeAdmission(deps, entry.directory, request.url));
    if (refusal) {
      await deps.claims.locks.release(holder);
      continue;
    }
    return {
      directory: entry.directory,
      created: await ownedFor(deps.claims, entry.directory, request.url),
      ...(remote ? { remote } : {}),
      detached: !entry.branch,
    };
  }
  return createWorktree(deps, request, holder, entries, remote);
}

// Whether Forgekeeper created the worktree for the PR/MR, so changes there
// are an earlier batch's.
async function ownedFor(claims: Claims, directory: string, url: string) {
  const row = await claims.worktrees.read(directory);
  return row?.state === 'ready' && row.url === url;
}

// Why the attempt can't run in the worktree now, or undefined when it can:
// another session there, other than `except`, such as the linked session
// about to run there, is running, or it has uncommitted changes, which only
// Forgekeeper's own worktree for the same PR/MR may keep.
export async function worktreeAdmission(
  deps: Pick<WorktreeDependencies, 'exec' | 'claims' | 'sessions'>,
  directory: string,
  url: string,
  except?: string,
): Promise<string | undefined> {
  const sessions = await deps.sessions(directory);
  if (sessions.some((session) => session.id !== except && isBusy(session)))
    return `Another session is running in ${directory}`;
  if (!(await ownedFor(deps.claims, directory, url)) && !(await isClean(deps.exec, directory)))
    return `${directory} has uncommitted changes that this task didn't make`;
  return undefined;
}

async function createWorktree(
  deps: WorktreeDependencies,
  request: WorktreeRequest,
  holder: CheckoutLock,
  entries: WorktreeEntry[],
  remote: string | undefined,
): Promise<WorktreePlacement> {
  const { exec, claims, projectID } = deps;
  const creation = randomBytes(4).toString('hex');
  const name = worktreeName(request, creation);
  const at = deps.now();
  const intent: WorktreeIntent = {
    key: `intent:${name}`,
    name,
    url: request.url,
    projectID,
    state: 'creating',
    at,
    creation,
  };
  if (!(await claims.worktrees.save(intent)))
    throw new Error('Another instance is creating this worktree');
  const before = new Set((await deps.worktree.list({ projectID })).map((entry) => entry.directory));
  let directory: string;
  try {
    directory = (await deps.worktree.create({ projectID, branch: request.headSha, name }))
      .directory;
  } catch (error) {
    // A start command can fail after the worktree exists. The requested
    // name is this creation's alone, so what appeared under it is the one
    // it made.
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
  const [recorded] =
    (await claims.worktrees.replace(intent, [
      { ...intent, key: directory, directory, state: 'ready' },
    ])) ?? [];
  if (!recorded) throw new Error('The new worktree is recorded for another creation already');
  // Fails once the attempt ended during the creation, such as when its
  // owning session was deleted. The worktree stays recorded for cleanup.
  if (!(await claims.locks.acquire(directory, holder)))
    throw new Error('The attempt ended, or another took the new worktree, while it was created');
  const state = await checkoutState(exec, directory);
  if (state?.head !== request.headSha)
    throw new Error("The new worktree isn't at the PR/MR's head commit");
  const detached = !(await switchToBranch(deps, directory, request, entries, remote));
  return { directory, created: true, ...(remote ? { remote } : {}), detached };
}

// Puts the new, detached worktree on the source branch when that changes no
// branch, and the branch pushes to the source project: the local branch is
// at the head commit and checked out nowhere, or there is none yet. Returns
// whether it did.
async function switchToBranch(
  deps: WorktreeDependencies,
  directory: string,
  request: WorktreeRequest,
  entries: WorktreeEntry[],
  remote: string | undefined,
): Promise<boolean> {
  const { exec } = deps;
  const branch = request.sourceBranch;
  if (entries.some((entry) => entry.branch === branch)) return false;
  const local = await localBranch(exec, directory, branch);
  if (local) {
    if (local !== request.headSha || !(await git(exec, directory, ['switch', branch])))
      return false;
  } else {
    if (!remote || !(await git(exec, directory, ['switch', '--create', branch]))) return false;
    await git(exec, directory, ['config', `branch.${branch}.remote`, remote]);
    await git(exec, directory, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  }
  // A same-named branch of another fork, say, pushes elsewhere, so the
  // worktree stays detached, with the source project's remote to push to.
  if (!(await worktreeMismatch(exec, deps.repository, directory, request))) return true;
  if (!(await git(exec, directory, ['switch', '--detach', request.headSha])))
    throw new Error("The new worktree's branch isn't the PR/MR's source branch");
  return false;
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
// one OpenCode lists under the requested name, which holds the creation's
// random part. An intent without one, from an earlier version, names
// nothing only its creation could have made, so it's dropped, and whatever
// it left is never removed.
async function adoptLeftovers(
  deps: SweepDependencies,
  intent: WorktreeIntent,
  rows: readonly (WorktreeIntent | RecordedWorktree)[],
) {
  if (deps.now() - intent.at < CREATION_TIME) return;
  const listed = await deps.worktree.list({ projectID: deps.projectID }).catch(() => undefined);
  if (!listed) return;
  const known = new Set(rows.map((row) => row.directory));
  const left = intent.creation
    ? listed.filter(
        (entry) =>
          entry.strategy &&
          !known.has(entry.directory) &&
          nameMatches(entry.directory, intent.name),
      )
    : [];
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
