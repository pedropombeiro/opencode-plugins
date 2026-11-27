import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface DestinationBase {
  acceptsUnrelated?: boolean;
  includeCheckoutMetadataOnUnrelated?: boolean;
}

interface ClosedMatchOptions {
  reopenLabels?: string[];
  resolutionLabelPrefix?: string;
}

export interface GitLabDestination extends DestinationBase, ClosedMatchOptions {
  type: 'gitlab';
  project: string;
  epic?: string;
  host: string;
  confidential: boolean;
  labels: string[];
}

export interface GitHubDestination extends DestinationBase, ClosedMatchOptions {
  type: 'github';
  repo: string;
  host: string;
  labels: string[];
}

export interface FileDestination extends DestinationBase {
  type: 'file';
  path: string;
}

export type DestinationConfig = GitLabDestination | GitHubDestination | FileDestination;

export interface DestinationRoute {
  directoryPrefix?: string;
  remoteContains?: string;
  remoteRepository?: string;
  destination: string;
  enforced?: boolean;
}

export interface ResolvedVentOptions {
  defaultDestination?: string;
  destinations: Record<string, DestinationConfig>;
  routes: DestinationRoute[];
  similarityThreshold: number;
}

export interface ResolvedDestination {
  name: string;
  config: DestinationConfig;
  unrelatedOverride?: boolean;
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.45;

export function expandHome(inputPath: string, home: string = homedir()): string {
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return resolve(home, inputPath.slice(2));
  }
  return inputPath;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validHost(value: unknown, fallback: string): string | undefined {
  const host = stringValue(value) ?? fallback;
  if (host.startsWith('-') || /[\s/]/.test(host)) return undefined;
  return host;
}

function normalizeRepoPath(value: unknown): string | undefined {
  const raw = stringValue(value)?.replace(/^\/+|\/+$/g, '');
  if (!raw || raw.startsWith('-') || /\s/.test(raw) || !raw.includes('/')) return undefined;
  return raw;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => item !== undefined);
}

function parseDestination(raw: unknown): DestinationConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const type = stringValue(record.type);
  const base: DestinationBase = {
    ...(record.acceptsUnrelated === true ? { acceptsUnrelated: true } : {}),
    ...(record.includeCheckoutMetadataOnUnrelated === true
      ? { includeCheckoutMetadataOnUnrelated: true }
      : {}),
  };
  const reopenLabels = stringArray(record.reopenLabels);
  const resolutionLabelPrefix = stringValue(record.resolutionLabelPrefix);
  const closedMatch: ClosedMatchOptions = {
    ...(reopenLabels.length > 0 ? { reopenLabels } : {}),
    ...(resolutionLabelPrefix ? { resolutionLabelPrefix } : {}),
  };

  if (type === 'gitlab') {
    const project = normalizeRepoPath(record.project);
    const host = validHost(record.host, 'gitlab.com');
    if (!project || !host) return undefined;
    const epic = stringValue(record.epic);
    return {
      type: 'gitlab',
      project,
      ...(epic ? { epic } : {}),
      host,
      confidential: typeof record.confidential === 'boolean' ? record.confidential : true,
      labels: stringArray(record.labels),
      ...closedMatch,
      ...base,
    };
  }

  if (type === 'github') {
    const repo = normalizeRepoPath(record.repo);
    const host = validHost(record.host, 'github.com');
    if (!repo || !host) return undefined;
    return {
      type: 'github',
      repo,
      host,
      labels: stringArray(record.labels),
      ...closedMatch,
      ...base,
    };
  }

  if (type === 'file') {
    const filePath = stringValue(record.path);
    if (!filePath) return undefined;
    return {
      type: 'file',
      path: filePath,
      ...base,
    };
  }

  return undefined;
}

function parseRoute(raw: unknown): DestinationRoute | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const destination = stringValue(record.destination);
  if (!destination) return undefined;
  const directoryPrefix = stringValue(record.directoryPrefix);
  const remoteContains = stringValue(record.remoteContains);
  const remoteRepository = stringValue(record.remoteRepository);
  if (!directoryPrefix && !remoteContains && !remoteRepository) return undefined;
  return {
    ...(directoryPrefix ? { directoryPrefix } : {}),
    ...(remoteContains ? { remoteContains } : {}),
    ...(remoteRepository ? { remoteRepository } : {}),
    destination,
    ...(record.enforced === true ? { enforced: true } : {}),
  };
}

export function resolveOptions(raw: unknown): ResolvedVentOptions {
  if (!raw || typeof raw !== 'object') {
    return {
      destinations: {},
      routes: [],
      similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    };
  }

  const record = raw as Record<string, unknown>;
  const destinations: Record<string, DestinationConfig> = {};

  if (record.destinations && typeof record.destinations === 'object') {
    for (const [name, value] of Object.entries(record.destinations as Record<string, unknown>)) {
      const trimmedName = name.trim();
      if (
        !trimmedName ||
        trimmedName === '__proto__' ||
        trimmedName === 'prototype' ||
        trimmedName === 'constructor'
      ) {
        continue;
      }
      const parsed = parseDestination(value);
      if (parsed) destinations[trimmedName] = parsed;
    }
  }

  const routes: DestinationRoute[] = Array.isArray(record.routes)
    ? record.routes
        .map((entry) => parseRoute(entry))
        .filter((entry): entry is DestinationRoute => entry !== undefined)
    : [];

  const defaultDestination = stringValue(record.defaultDestination);
  const threshold =
    typeof record.similarityThreshold === 'number' &&
    Number.isFinite(record.similarityThreshold) &&
    record.similarityThreshold > 0 &&
    record.similarityThreshold <= 1
      ? record.similarityThreshold
      : DEFAULT_SIMILARITY_THRESHOLD;

  return {
    ...(defaultDestination ? { defaultDestination } : {}),
    destinations,
    routes,
    similarityThreshold: threshold,
  };
}

function matchScpRemote(remote: string): { host: string; path: string } | undefined {
  if (remote.includes('://')) return undefined;
  const withUser = remote.match(/^[^@/\s]+@([^:/@\s]+):\/?(.+)$/);
  if (withUser) {
    return { host: withUser[1]!, path: withUser[2]!.replace(/^\/+/, '') };
  }
  const withoutUser = remote.match(/^([^:/@\s]{2,}):\/?(.+)$/);
  if (withoutUser) {
    return { host: withoutUser[1]!, path: withoutUser[2]!.replace(/^\/+/, '') };
  }
  return undefined;
}

function normalizeRemote(remote: string): string {
  const scp = matchScpRemote(remote.trim());
  if (scp) return `${scp.host}/${scp.path}`;
  return remote;
}

function matchesRemote(remote: string, pattern: string): boolean {
  const needle = pattern.toLowerCase();
  return (
    remote.toLowerCase().includes(needle) ||
    normalizeRemote(remote).toLowerCase().includes(needle) ||
    sanitizeRemote(remote).toLowerCase().includes(needle)
  );
}

export function sanitizeRemote(remote: string): string {
  const trimmed = remote.trim();
  if (!trimmed) return '';
  if (trimmed.includes('://')) {
    if (URL.canParse(trimmed)) {
      const url = new URL(trimmed);
      return `${url.hostname}${url.pathname.replace(/\/+/g, '/')}`
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '');
    }
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
    const slashIndex = withoutScheme.indexOf('/');
    const authority = slashIndex >= 0 ? withoutScheme.slice(0, slashIndex) : withoutScheme;
    const pathPart =
      slashIndex >= 0 ? `/${withoutScheme.slice(slashIndex + 1).replace(/^\/+/, '')}` : '';
    const host = authority.replace(/^.*@/, '').replace(/:\d+$/, '');
    return `${host}${pathPart}`.replace(/\/+$/, '').replace(/\.git$/i, '');
  }
  const scp = matchScpRemote(trimmed);
  if (scp) {
    return `${scp.host}/${scp.path}`.replace(/\/+$/, '').replace(/\.git$/i, '');
  }
  const slashIndex = trimmed.indexOf('/');
  const firstSegment = slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed;
  const rest = slashIndex >= 0 ? trimmed.slice(slashIndex) : '';
  return `${firstSegment.replace(/^.*@/, '')}${rest}`
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

function repositoryIdentity(remote: string): string {
  return sanitizeRemote(remote).toLowerCase();
}

export function canonicalizePath(inputPath: string): string {
  const resolved = resolve(inputPath);
  const trailingSegments: string[] = [];
  let current = resolved;

  while (true) {
    try {
      const real = realpathSync.native(current);
      return trailingSegments.length > 0 ? join(real, ...trailingSegments.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return resolved;
      }
      trailingSegments.push(basename(current));
      current = parent;
    }
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function matchesPrefix(directory: string, prefix: string, home: string): boolean {
  const lexicalDir = resolve(expandHome(directory, home));
  const lexicalPrefix = resolve(expandHome(prefix, home));
  if (isPathInside(lexicalDir, lexicalPrefix)) return true;

  const canonicalDir = canonicalizePath(lexicalDir);
  const canonicalPrefix = canonicalizePath(lexicalPrefix);
  return isPathInside(canonicalDir, canonicalPrefix);
}

function getDestination(
  destinations: Record<string, DestinationConfig>,
  name: string | undefined,
): DestinationConfig | undefined {
  if (!name || !Object.hasOwn(destinations, name)) return undefined;
  return destinations[name];
}

export function selectDestination(
  options: ResolvedVentOptions,
  context: {
    requested?: string;
    directory?: string;
    remote?: string;
    fetchRemotes?: readonly string[];
    remoteLookupFailed?: boolean;
    remoteLookupError?: string;
    unrelatedReason?: string;
    home?: string;
  },
): ResolvedDestination {
  const names = Object.keys(options.destinations);
  if (names.length === 0) {
    throw new Error(
      'No vent destinations are configured. Add a `destinations` entry to the `opencode-vent` plugin options.',
    );
  }

  const home = context.home ?? homedir();
  const fetchRemotes = context.fetchRemotes ?? (context.remote ? [context.remote] : []);
  const matchingRoutes = options.routes.filter((route) => {
    const directoryMatches =
      !route.directoryPrefix ||
      (context.directory !== undefined &&
        matchesPrefix(context.directory, route.directoryPrefix, home));
    if (!directoryMatches) return false;
    if (!route.remoteContains && !route.remoteRepository) return true;
    return fetchRemotes.some(
      (remote) =>
        (!route.remoteContains || matchesRemote(remote, route.remoteContains)) &&
        (!route.remoteRepository ||
          repositoryIdentity(remote) === repositoryIdentity(route.remoteRepository)),
    );
  });

  const enforced = matchingRoutes.find((route) => route.enforced);
  const requested = getDestination(options.destinations, context.requested);
  if (context.requested && !requested) {
    throw new Error(
      `Unknown vent destination "${context.requested}". Configured destinations: ${names.join(', ')}.`,
    );
  }
  if (context.unrelatedReason && !requested) {
    throw new Error('`unrelatedReason` requires an explicit destination.');
  }

  if (!enforced && context.remoteLookupFailed) {
    const unverifiedEnforced = options.routes.find((route) => {
      if (!route.enforced || (!route.remoteContains && !route.remoteRepository)) return false;
      return (
        !route.directoryPrefix ||
        (context.directory !== undefined &&
          matchesPrefix(context.directory, route.directoryPrefix, home))
      );
    });
    if (unverifiedEnforced) {
      const detail = context.remoteLookupError ? `: ${context.remoteLookupError}` : '.';
      throw new Error(
        `Cannot evaluate enforced vent route for "${unverifiedEnforced.destination}" because git remote discovery failed${detail}`,
      );
    }
  }

  if (enforced) {
    const config = getDestination(options.destinations, enforced.destination);
    if (!config || config.type === 'file') {
      throw new Error(
        `Enforced vent route requires a configured issue destination: "${enforced.destination}".`,
      );
    }
    if (requested && context.requested !== enforced.destination) {
      if (requested.acceptsUnrelated && context.unrelatedReason?.trim()) {
        return { name: context.requested!, config: requested, unrelatedOverride: true };
      }
      const accepting = names.filter(
        (name) => name !== enforced.destination && options.destinations[name]!.acceptsUnrelated,
      );
      const hint =
        accepting.length > 0
          ? `For friction unrelated to this checkout, set destination to one of ${accepting.map((name) => `"${name}"`).join(', ')} and explain why in unrelatedReason.`
          : 'No configured destination accepts unrelated friction (`acceptsUnrelated`).';
      throw new Error(
        `This checkout routes vents to "${enforced.destination}". Omit destination for project friction. ${hint}`,
      );
    }
    return { name: enforced.destination, config };
  }
  if (requested) {
    return {
      name: context.requested!,
      config: requested,
      ...(context.unrelatedReason?.trim() ? { unrelatedOverride: true } : {}),
    };
  }

  const route = matchingRoutes.find((entry) =>
    Boolean(getDestination(options.destinations, entry.destination)),
  );
  if (route) {
    return {
      name: route.destination,
      config: getDestination(options.destinations, route.destination)!,
    };
  }

  if (options.defaultDestination) {
    const config = getDestination(options.destinations, options.defaultDestination);
    if (!config) {
      throw new Error(
        `Configured defaultDestination "${options.defaultDestination}" was not found in destinations (${names.join(', ')}).`,
      );
    }
    return { name: options.defaultDestination, config };
  }

  if (names.length === 1) {
    const only = names[0]!;
    return { name: only, config: options.destinations[only]! };
  }

  throw new Error(
    `Multiple vent destinations are configured (${names.join(', ')}), but no route matched and no defaultDestination is set.`,
  );
}
