import type { Exec } from './exec';

export interface RemoteProject {
  host: string;
  path: string;
}

export interface Repository {
  head: string;
  branch: string;
  // The branch name on the remote the MR's source project uses. It differs from
  // `branch` when the local branch tracks a differently named remote branch.
  sourceBranch: string;
  source: RemoteProject;
  // Projects that could own the MR: the source project and every other remote
  // on the same host, so MRs from a fork into its upstream are found.
  targets: RemoteProject[];
}

export type RepositoryLookup =
  | { kind: 'repository'; repository: Repository }
  | { kind: 'none'; reason: string };

export function parseRemote(url: string): RemoteProject | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;

  const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!['ssh:', 'https:', 'http:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol))
      return undefined;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  }

  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!host || !path.includes('/')) return undefined;
  return { host: host.toLowerCase(), path };
}

// Whether a remote host belongs to a forge the caller can look up.
export type HostFilter = (host: string) => boolean;

const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, '');

async function git(run: Exec, directory: string, args: string[]) {
  const result = await run('git', args, directory);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function resolveRepository(
  run: Exec,
  directory: string,
  supported: HostFilter,
): Promise<RepositoryLookup> {
  const top = await git(run, directory, ['rev-parse', '--show-toplevel']);
  if (top === undefined) return { kind: 'none', reason: 'Not a Git repository' };

  const branch = await git(run, directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return { kind: 'none', reason: 'Detached HEAD' };

  const [head, refs, remoteConfig] = await Promise.all([
    git(run, directory, ['rev-parse', 'HEAD']),
    git(run, directory, [
      'for-each-ref',
      '--format=%(push:remotename)%00%(push:remoteref)%00%(upstream:remotename)%00%(upstream:remoteref)',
      `refs/heads/${branch}`,
    ]),
    git(run, directory, ['config', '--get-regexp', '^remote\\..*\\.url$']),
  ]);

  const remotes = new Map<string, string>();
  for (const line of (remoteConfig ?? '').split('\n')) {
    const match = line.match(/^remote\.(.+)\.url\s+(.+)$/);
    if (match) remotes.set(match[1], match[2]);
  }
  if (remotes.size === 0) return { kind: 'none', reason: 'No Git remotes' };

  const [pushRemote, pushRef, upstreamRemote, upstreamRef] = (refs ?? '').split('\0');
  let sourceRemote: string | undefined;
  let sourceBranch = branch;
  if (pushRemote && remotes.has(pushRemote)) {
    sourceRemote = pushRemote;
    // `push.default=simple` names no push branch when the upstream branch
    // has another name, so the branch pushes to its upstream on that remote.
    if (pushRef) sourceBranch = stripHeads(pushRef);
    else if (upstreamRef && upstreamRemote === pushRemote) sourceBranch = stripHeads(upstreamRef);
  } else if (upstreamRemote && remotes.has(upstreamRemote)) {
    sourceRemote = upstreamRemote;
    if (upstreamRef) sourceBranch = stripHeads(upstreamRef);
  } else if (remotes.has('origin')) {
    sourceRemote = 'origin';
  } else if (remotes.size === 1) {
    sourceRemote = [...remotes.keys()][0];
  }
  if (!sourceRemote) return { kind: 'none', reason: 'No remote for the current branch' };

  const source = parseRemote(remotes.get(sourceRemote)!);
  if (!source || !supported(source.host))
    return { kind: 'none', reason: 'Not a supported forge remote' };

  const remoteHead = await git(run, directory, [
    'symbolic-ref',
    '--quiet',
    '--short',
    `refs/remotes/${sourceRemote}/HEAD`,
  ]);
  if (remoteHead && remoteHead === `${sourceRemote}/${sourceBranch}`) {
    return { kind: 'none', reason: 'Default branch' };
  }

  const targets: RemoteProject[] = [source];
  for (const url of remotes.values()) {
    const project = parseRemote(url);
    if (!project || project.host !== source.host) continue;
    if (targets.some((target) => target.path.toLowerCase() === project.path.toLowerCase()))
      continue;
    targets.push(project);
  }

  return {
    kind: 'repository',
    repository: { head: head ?? '', branch, sourceBranch, source, targets },
  };
}

// A checkout of the repository, as `git worktree list` reports it.
export interface WorktreeEntry {
  directory: string;
  head?: string;
  // The local branch it has checked out, or undefined for a detached HEAD.
  branch?: string;
  // Bare, locked, or prunable, so it can't be reused.
  unusable: boolean;
}

export async function listWorktrees(
  run: Exec,
  directory: string,
): Promise<WorktreeEntry[] | undefined> {
  const output = await git(run, directory, ['worktree', 'list', '--porcelain']);
  if (output === undefined) return undefined;
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let entry: WorktreeEntry | undefined;
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') entry = { directory: value, unusable: false };
      else if (!entry) continue;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = stripHeads(value);
      else if (key === 'bare' || key === 'locked' || key === 'prunable') entry.unusable = true;
    }
    if (entry) entries.push(entry);
  }
  return entries;
}

// The checkout's top directory, head commit, and local branch, or undefined
// on a detached HEAD. Unlike `resolveRepository`, it reads detached HEADs.
export async function checkoutState(
  run: Exec,
  directory: string,
): Promise<{ top: string; head: string; branch?: string } | undefined> {
  const [top, head, branch] = await Promise.all([
    git(run, directory, ['rev-parse', '--show-toplevel']),
    git(run, directory, ['rev-parse', 'HEAD']),
    git(run, directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ]);
  if (!top || !head) return undefined;
  return { top, head, ...(branch ? { branch } : {}) };
}

// The output of `git status --short`, including untracked files, or
// undefined when it can't be read.
export const shortStatus = (run: Exec, directory: string) =>
  git(run, directory, ['status', '--short', '--untracked-files=all']);

// Whether the checkout has no uncommitted or untracked changes. False when
// that can't be read.
export async function isClean(run: Exec, directory: string): Promise<boolean> {
  return (await shortStatus(run, directory)) === '';
}

export async function hasCommit(run: Exec, directory: string, sha: string): Promise<boolean> {
  return (await git(run, directory, ['cat-file', '-e', `${sha}^{commit}`])) !== undefined;
}

// Whether `ancestor` is `descendant` or one of its ancestors. False when
// either is missing.
export async function isAncestor(
  run: Exec,
  directory: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (
    (await git(run, directory, ['merge-base', '--is-ancestor', ancestor, descendant])) !== undefined
  );
}

// The commit of the local branch, or undefined when there is none.
export const localBranch = (run: Exec, directory: string, branch: string) =>
  git(run, directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);

// The remote whose URL is the project, preferring `origin`.
export async function remoteFor(
  run: Exec,
  directory: string,
  project: RemoteProject,
): Promise<string | undefined> {
  const remoteConfig = await git(run, directory, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  const names: string[] = [];
  for (const line of (remoteConfig ?? '').split('\n')) {
    const match = line.match(/^remote\.(.+)\.url\s+(.+)$/);
    const parsed = match && parseRemote(match[2]);
    if (
      parsed &&
      parsed.host === project.host &&
      parsed.path.toLowerCase() === project.path.toLowerCase()
    )
      names.push(match![1]);
  }
  return names.includes('origin') ? 'origin' : names[0];
}

// Fetches only the branch from the remote. Updates no local branch.
export async function fetchBranch(
  run: Exec,
  directory: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  return (
    (await git(run, directory, ['fetch', '--no-tags', remote, `refs/heads/${branch}`])) !==
    undefined
  );
}

export type ProjectsLookup =
  | { kind: 'projects'; projects: RemoteProject[] }
  | { kind: 'none'; reason: string };

// Lists the projects on accepted hosts behind a checkout's remotes, `origin`
// first and all on one host, for looking up a PR/MR by number regardless of the
// checked-out branch.
export async function resolveProjects(
  run: Exec,
  directory: string,
  accepted: HostFilter,
): Promise<ProjectsLookup> {
  const remoteConfig = await git(run, directory, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (remoteConfig === undefined) return { kind: 'none', reason: 'No Git remotes' };

  const remotes: Array<[string, string]> = [];
  for (const line of remoteConfig.split('\n')) {
    const match = line.match(/^remote\.(.+)\.url\s+(.+)$/);
    if (match) remotes.push([match[1], match[2]]);
  }
  remotes.sort(([a], [b]) => Number(b === 'origin') - Number(a === 'origin'));

  const projects: RemoteProject[] = [];
  for (const [, url] of remotes) {
    const project = parseRemote(url);
    if (!project || !accepted(project.host)) continue;
    if (projects.length > 0 && project.host !== projects[0].host) continue;
    if (projects.some((known) => known.path.toLowerCase() === project.path.toLowerCase())) continue;
    projects.push(project);
  }
  return projects.length > 0
    ? { kind: 'projects', projects }
    : { kind: 'none', reason: 'No matching forge remote' };
}
