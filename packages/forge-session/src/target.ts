import type { ReviewRef } from './forge';
import { parseReference, parseUrl, traits } from './forges';
import type { TargetOutput } from './rpc';

// One of a session's explicit targets, as set_session_target stores it.
// `branchIssue` is the issue number in the PR/MR's source branch name, which
// the title shows when no `issueUrl` was given.
// A type alias rather than an interface, so it is assignable to plugin storage's JSON type.
export type Target = {
  url: string;
  issueUrl?: string;
  branchIssue?: string;
};

// The most targets a session can have, so that a runaway call can't make
// every status poll query hundreds of PRs/MRs.
export const MAX_TARGETS = 50;
// A title prefix with more targets lists the first few and counts the rest.
const PREFIX_REFERENCES = 4;

interface Reference {
  url: string;
  ref: ReviewRef;
  issue: boolean;
}

const INVALID_URL = 'Use a full HTTP(S) issue, pull request, or merge request URL.';

// Validates a target URL and normalizes it, dropping the query, the fragment,
// and a trailing slash, so equivalent links store the same target.
function parseTargetUrl(value: string): Reference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(INVALID_URL);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error(INVALID_URL);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  const parsed = parseReference(url.href);
  if (!parsed) throw new Error('Use a GitHub or GitLab issue, pull request, or merge request URL.');
  return { url: url.href, ...parsed };
}

// Parses a single `target` and its `issue_url`. Undefined means automatic branch mode.
export function parseTarget(input: unknown): Target | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    !('target' in input) ||
    typeof input.target !== 'string'
  ) {
    throw new Error('Provide a target URL or "branch".');
  }
  const issueUrl = 'issue_url' in input ? input.issue_url : undefined;
  if (input.target === 'branch') {
    if (issueUrl !== undefined) throw new Error('Branch mode does not accept issue_url.');
    return undefined;
  }
  return relate(parseTargetUrl(input.target), issueUrl);
}

// A target with its related issue, if `issueUrl` is given. Only a PR/MR can
// have one, and only from its own forge.
function relate(target: Reference, issueUrl: unknown): Target {
  if (issueUrl === undefined) return { url: target.url };
  if (typeof issueUrl !== 'string') throw new Error('issue_url must be a full issue URL.');
  const issue = parseTargetUrl(issueUrl);
  if (target.issue || !issue.issue || target.ref.forge !== issue.ref.forge) {
    throw new Error('Only a pull or merge request can have a related issue from the same forge.');
  }
  return { url: target.url, issueUrl: issue.url };
}

export type Operation = 'replace' | 'add' | 'remove';
export type TargetChange = { operation: Operation; targets: Target[] } | { operation: 'branch' };

const OPERATIONS = new Set<unknown>(['replace', 'add', 'remove']);

// Keeps the first position of each URL and its last details.
const dedupe = (targets: Target[]) => [
  ...new Map(targets.map((target) => [target.url, target])).values(),
];

// Parses set_session_target's input: one `target` or several `targets`, and
// how they change the session's current targets. With `targets`, `issue_url`
// relates every one of them, which must all be PRs/MRs, to the same issue.
export function parseTargetChange(input: unknown): TargetChange {
  if (!input || typeof input !== 'object')
    throw new Error('Provide a target URL, "branch", or a list of targets.');
  const value = input as Record<string, unknown>;
  const operation = (value.operation ?? 'replace') as Operation;
  if (!OPERATIONS.has(operation))
    throw new Error('operation must be "replace", "add", or "remove".');

  if (operation === 'remove' && value.issue_url !== undefined)
    throw new Error('Removing a target does not accept issue_url.');

  if (value.targets !== undefined) {
    if (value.target !== undefined) throw new Error('Use either target or targets, not both.');
    const urls = value.targets;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      !urls.every((url) => typeof url === 'string')
    ) {
      throw new Error('targets must be a non-empty list of full URLs.');
    }
    if (urls.includes('branch'))
      throw new Error('Use target: "branch" on its own to return to branch-based naming.');
    if (urls.length > MAX_TARGETS)
      throw new Error(`A session can have at most ${MAX_TARGETS} targets.`);
    return {
      operation,
      targets: dedupe(urls.map((url) => relate(parseTargetUrl(url), value.issue_url))),
    };
  }

  if (value.target === 'branch' && operation !== 'replace')
    throw new Error('"branch" replaces every target, so it takes no operation.');
  const target = parseTarget(value);
  return target ? { operation, targets: [target] } : { operation: 'branch' };
}

// Applies a change to the session's targets. `missing` lists the URLs that a
// removal named but the session didn't have.
export function applyTargetChange(
  current: readonly Target[],
  change: TargetChange,
): { targets: Target[]; missing: string[] } {
  if (change.operation === 'branch') return { targets: [], missing: [] };
  const known = new Map(current.map((target) => [target.url, target]));

  if (change.operation === 'remove') {
    const removed = new Set(change.targets.map((target) => target.url));
    return {
      targets: current.filter((target) => !removed.has(target.url)),
      missing: [...removed].filter((url) => !known.has(url)),
    };
  }

  // A target that the session already has keeps its inferred issue, so its
  // source branch isn't looked up again. Adding it again also keeps its
  // explicit issue. An explicit issue in the change always wins.
  const merge = (target: Target): Target => {
    const existing = known.get(target.url);
    if (!existing || target.issueUrl) return target;
    if (change.operation === 'add') return { ...existing };
    return {
      url: target.url,
      ...(existing.branchIssue ? { branchIssue: existing.branchIssue } : {}),
    };
  };
  const targets =
    change.operation === 'replace'
      ? change.targets.map(merge)
      : dedupe([...current.map((target) => ({ ...target })), ...change.targets.map(merge)]);
  if (targets.length > MAX_TARGETS)
    throw new Error(`A session can have at most ${MAX_TARGETS} targets.`);
  return { targets, missing: [] };
}

// The PR/MR a target names, or undefined for an issue.
export function targetRequest(target: Target): ReviewRef | undefined {
  const { ref, issue } = parseTargetUrl(target.url);
  return issue ? undefined : ref;
}

// Whether two references name the same PR/MR. Forges ignore the case of
// project paths, so a forge's URL can differ from the target's.
export const sameRef = (a: ReviewRef, b: ReviewRef) =>
  a.forge === b.forge &&
  a.host === b.host &&
  a.iid === b.iid &&
  a.project.toLowerCase() === b.project.toLowerCase();

// Whether a PR/MR URL, as a forge reports it, is one of the targets.
export function includesRequest(targets: readonly Target[], url: string): boolean {
  const ref = parseUrl(url);
  if (!ref) return false;
  return targets.some((target) => {
    const request = targetRequest(target);
    return request !== undefined && sameRef(request, ref);
  });
}

// The target's own reference, such as `!45` or `#12`.
function mainReference(target: Target): string {
  const { ref, issue } = parseTargetUrl(target.url);
  const forge = traits(ref.forge);
  return issue ? forge.issueReference(ref.iid) : forge.reference(ref.iid);
}

// A PR/MR's related issue: the explicit `issueUrl`, or else the issue in its
// source branch name, which is in the PR/MR's own project. `id` tells issues
// with the same number in different projects apart.
function relatedIssue(target: Target): { id: string; reference: string } | undefined {
  const { ref, issue } = parseTargetUrl(target.url);
  let related: ReviewRef;
  if (target.issueUrl) related = parseTargetUrl(target.issueUrl).ref;
  else if (!issue && target.branchIssue) related = { ...ref, iid: target.branchIssue };
  else return undefined;
  return {
    id: `${related.forge} ${related.host} ${related.project.toLowerCase()} ${related.iid}`,
    reference: traits(related.forge).issueReference(related.iid),
  };
}

// The title prefix for a target, such as `[#12, !45]`.
export const targetPrefix = (target: Target): string => targetsPrefix([target])!;

// The title prefix for a session's targets, such as `[#12, !45, !46]`. The
// related issue comes first when every target has the same one. Otherwise
// the prefix lists only the targets' own references, such as `[!45, #7]`.
// Long lists end with a count, such as `[!45, !46, !47, +3]`.
export function targetsPrefix(targets: readonly Target[]): string | undefined {
  if (targets.length === 0) return undefined;
  const issues = targets.map(relatedIssue);
  const shared = issues.every((issue) => issue && issue.id === issues[0]?.id)
    ? issues[0]?.reference
    : undefined;
  const references = targets.map(mainReference);
  const shown =
    references.length > PREFIX_REFERENCES
      ? [
          ...references.slice(0, PREFIX_REFERENCES - 1),
          `+${references.length - PREFIX_REFERENCES + 1}`,
        ]
      : references;
  return `[${[...(shared ? [shared] : []), ...shown].join(', ')}]`;
}

const urlsOf = (target: Target) => ({
  url: target.url,
  ...(target.issueUrl ? { issueUrl: target.issueUrl } : {}),
});

// `url` and `issueUrl` describe the first target, for callers that expect one.
export const targetOutput = (targets: readonly Target[] | undefined): TargetOutput =>
  targets?.length ? { ...urlsOf(targets[0]), targets: targets.map(urlsOf) } : {};

export type SessionTarget =
  | { kind: 'merge-request'; ref: ReviewRef; url: string }
  | { kind: 'other'; url: string };

const classify = (url: string): SessionTarget => {
  const ref = parseUrl(url);
  return ref ? { kind: 'merge-request', ref, url } : { kind: 'other', url };
};

// Classifies the `target` RPC output. Undefined means the session has no
// explicit target; "other" is an explicit target that isn't a PR/MR, such as
// an issue. Output without `targets` comes from a server that predates them.
export function classifyTargets(output: unknown): SessionTarget[] | undefined {
  const value = output as { url?: unknown; targets?: unknown } | undefined;
  const urls = (
    Array.isArray(value?.targets) ? value.targets.map((target) => target?.url) : [value?.url]
  ).filter((url): url is string => typeof url === 'string' && url !== '');
  return urls.length ? urls.map(classify) : undefined;
}
