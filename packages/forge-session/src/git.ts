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
    if (pushRef) sourceBranch = stripHeads(pushRef);
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
