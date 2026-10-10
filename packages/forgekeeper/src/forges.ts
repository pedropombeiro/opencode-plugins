import type { Exec } from './exec';
import type { Forge, ForgeKind, ForgeTraits, ReviewRef, ReviewRequest } from './forge';
import {
  resolveProjects,
  resolveRepository,
  type RemoteProject,
  type RepositoryLookup,
} from './git';
import { githubTraits } from './github';
import { gitlabTraits } from './gitlab';

const registry = { gitlab: gitlabTraits, github: githubTraits };

export const kinds = Object.keys(registry) as ForgeKind[];

// The traits of one forge.
export const traits = <Kind extends ForgeKind>(kind: Kind) => registry[kind];

// The traits of a request's forge. The lookup keys on the request's own
// forge, so the traits' methods always receive a request of their type.
export const traitsOf = (request: ReviewRequest): ForgeTraits => registry[request.forge];

// The request's number as its forge writes it, such as `!45` or `#7`.
export const reference = (request: ReviewRequest) => traitsOf(request).reference(request.iid);

// The PR/MR a web URL names on any forge.
export function parseUrl(url: string): ReviewRef | undefined {
  for (const kind of kinds) {
    const ref = registry[kind].parseUrl(url);
    if (ref) return ref;
  }
  return undefined;
}

// The PR/MR or issue a web URL names on any forge.
export function parseReference(url: string): { ref: ReviewRef; issue: boolean } | undefined {
  for (const kind of kinds) {
    const request = registry[kind].parseUrl(url);
    if (request) return { ref: request, issue: false };
    const issue = registry[kind].parseIssueUrl(url);
    if (issue) return { ref: issue, issue: true };
  }
  return undefined;
}

// Hosts each forge serves, besides the hosts it recognizes by name.
export type ForgeHosts = Record<ForgeKind, readonly string[]>;

// The `hosts` and `githubHosts` plugin options, which both entry points read.
export function hostsFrom(options: Record<string, unknown>): ForgeHosts {
  const list = (value: unknown, fallback: string) =>
    Array.isArray(value)
      ? value.filter((host): host is string => typeof host === 'string')
      : [fallback];
  return {
    gitlab: list(options.hosts, 'gitlab.com'),
    github: list(options.githubHosts, 'github.com'),
  };
}

// What PR/MR lookup needs from the registry, so tests can supply fakes.
export interface ForgeCatalog {
  readonly kinds: readonly ForgeKind[];
  kind(host: string): ForgeKind | undefined;
  forHost(host: string, directory: string): Forge | undefined;
  projects(directory: string, kind: ForgeKind): Promise<RemoteProject[]>;
  repository(directory: string): Promise<RepositoryLookup>;
}

// Selects and creates forge adapters for a checkout. Adapters are created per
// directory, because `gh` and `glab` read repository context from their cwd.
export class Forges implements ForgeCatalog {
  readonly kinds = kinds;

  constructor(
    private readonly run: Exec,
    readonly hosts: ForgeHosts,
  ) {}

  // Configured hosts win over hosts that a forge recognizes by name.
  kind(host: string): ForgeKind | undefined {
    return (
      kinds.find((kind) => this.hosts[kind].includes(host)) ??
      kinds.find((kind) => registry[kind].recognizes(host))
    );
  }

  forHost(host: string, directory: string): Forge | undefined {
    const kind = this.kind(host);
    return kind ? registry[kind].open(this.run, directory) : undefined;
  }

  // The checkout's projects on one forge, `origin` first.
  async projects(directory: string, kind: ForgeKind): Promise<RemoteProject[]> {
    const lookup = await resolveProjects(this.run, directory, (host) => this.kind(host) === kind);
    return lookup.kind === 'projects' ? lookup.projects : [];
  }

  repository(directory: string): Promise<RepositoryLookup> {
    return resolveRepository(this.run, directory, (host) => this.kind(host) !== undefined);
  }
}
