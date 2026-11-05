import type { ReviewRef, ReviewRequest } from './forge';
import { parseUrl, traits, type ForgeCatalog } from './forges';
import { CONCURRENCY, mapLimit } from './limit';
import { TargetLookupError, type Lookup } from './store';
import { sameRef, type SessionTarget } from './target';

export interface Hints {
  request?: (
    ref: ReviewRef,
    load: () => Promise<ReviewRequest | undefined>,
  ) => Promise<ReviewRequest | undefined>;
  directory: string;
  // The session's explicit targets, stored by set_session_target.
  targets?: SessionTarget[];
  // The session title without the prefix this plugin wrote, so only a
  // reference that the user wrote, such as `[!45]`, counts. A branch prefix
  // the plugin wrote would otherwise outlive the branch's PR/MR.
  title?: string;
  // The session's previous lookup, which stands in for a target whose lookup
  // fails, so a passing error doesn't look like a change of review state.
  previous?: Lookup;
}

const UNRESOLVED = 'Explicit PR/MR target could not be resolved';

type Outcome = { request: ReviewRequest } | { missing: string } | { error: unknown };

// Looks up each PR/MR target. A failed lookup reuses the target's previous
// result and is listed in `failed`; it throws only when no lookup succeeded.
async function locateTargets(
  forges: ForgeCatalog,
  directory: string,
  targets: SessionTarget[],
  previous?: Lookup,
  cached?: Hints['request'],
): Promise<Lookup> {
  const requests = targets.flatMap((target) => (target.kind === 'merge-request' ? [target] : []));
  // An explicit target that isn't a PR/MR, such as an issue, means the session
  // isn't about one, so the branch's PR/MR would be misleading.
  if (requests.length === 0) {
    const reason =
      targets.length === 1
        ? `The session target is not a PR/MR (${targets[0].url})`
        : 'No session target is a PR/MR';
    return { kind: 'none', reason };
  }

  const outcomes = await mapLimit(requests, CONCURRENCY, async ({ ref }): Promise<Outcome> => {
    const forge =
      forges.kind(ref.host) === ref.forge ? forges.forHost(ref.host, directory) : undefined;
    if (!forge) return { missing: 'Unsupported session target host' };
    try {
      const load = () => forge.findByNumber([{ host: ref.host, path: ref.project }], ref.iid);
      const request = await (cached ? cached(ref, load) : load());
      return request ? { request } : { missing: UNRESOLVED };
    } catch (error) {
      return { error };
    }
  });

  const earlier = previous?.kind === 'found' ? previous.requests : [];
  const found: ReviewRequest[] = [];
  const failed: { url: string; reason: string }[] = [];
  let error: unknown;
  outcomes.forEach((outcome, index) => {
    const { ref, url } = requests[index];
    if ('request' in outcome) {
      found.push(outcome.request);
      return;
    }
    if ('missing' in outcome) {
      failed.push({ url, reason: outcome.missing });
      return;
    }
    error ??= outcome.error;
    const last = earlier.find((request) => {
      const parsed = parseUrl(request.url);
      return parsed && sameRef(parsed, ref);
    });
    if (last) found.push(last);
    failed.push({
      url,
      reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    });
  });

  if (error !== undefined && !outcomes.some((outcome) => 'request' in outcome))
    throw new TargetLookupError(error);
  // Never fall back to the branch, which may have a different PR/MR.
  if (found.length === 0)
    return {
      kind: 'none',
      reason:
        requests.length === 1 ? failed[0].reason : 'No session target PR/MR could be resolved',
      explicitTarget: true,
    };
  return {
    kind: 'found',
    sessionTarget:
      requests.length === 1
        ? found[0].url
        : `${requests.length} PRs/MRs set with set_session_target`,
    explicitTarget: true,
    requests: found,
    ...(failed.length ? { failed } : {}),
  };
}

// Picks the session's PRs/MRs: the explicit targets first, then a title
// reference, and finally the checked-out branch's open PRs/MRs.
export async function locate(forges: ForgeCatalog, hints: Hints): Promise<Lookup> {
  const { directory, targets, title } = hints;
  if (targets?.length)
    return locateTargets(forges, directory, targets, hints.previous, hints.request);

  // Each forge reads its own references from the title, on the forges the
  // checkout has remotes for. A reference can also name an issue, so it only
  // counts once the forge finds a PR/MR with that number.
  for (const kind of forges.kinds) {
    const numbers = traits(kind).titleReferences(title);
    if (numbers.length === 0) continue;
    const projects = await forges.projects(directory, kind);
    const forge = projects.length ? forges.forHost(projects[0].host, directory) : undefined;
    if (!forge) continue;
    for (const number of numbers) {
      const request = await forge.findByNumber(projects, number);
      if (request) {
        return {
          kind: 'found',
          sessionTarget: `${forge.traits.reference(number)} (from the session title)`,
          requests: [request],
        };
      }
    }
  }

  const lookup = await forges.repository(directory);
  if (lookup.kind === 'none') return lookup;
  const forge = forges.forHost(lookup.repository.source.host, directory);
  if (!forge) return { kind: 'none', reason: 'Not a supported forge remote' };
  return {
    kind: 'found',
    repository: lookup.repository,
    requests: await forge.findByBranch(lookup.repository),
  };
}
