import type { ReviewRef, ReviewRequest } from './forge';
import {
  aRequestNoun,
  forgeScope,
  parseReference,
  parseUrl,
  requestNoun,
  requestPlural,
  type ForgeCatalog,
} from './forges';
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
  // The session's previous lookup, which stands in for a target whose lookup
  // fails, so a passing error doesn't look like a change of review state.
  previous?: Lookup;
}

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
    const scope = forgeScope(targets.map((target) => parseReference(target.url)?.ref.forge));
    const aNoun = aRequestNoun(scope);
    const reason =
      targets.length === 1
        ? `The session target is not ${aNoun} (${targets[0].url})`
        : `No session target is ${aNoun}`;
    return { kind: 'none', reason, ...(scope ? { forge: scope } : {}) };
  }

  const scope = forgeScope(requests.map(({ ref }) => ref.forge));

  const outcomes = await mapLimit(requests, CONCURRENCY, async ({ ref }): Promise<Outcome> => {
    const adapter =
      forges.kind(ref.host) === ref.forge ? forges.forHost(ref.host, directory) : undefined;
    if (!adapter) return { missing: 'Unsupported session target host' };
    try {
      const load = () => adapter.findByNumber([{ host: ref.host, path: ref.project }], ref.iid);
      const request = await (cached ? cached(ref, load) : load());
      return request
        ? { request }
        : { missing: `Explicit ${requestNoun(ref.forge)} target could not be resolved` };
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
    throw new TargetLookupError(error, scope);
  // Never fall back to the branch, which may have a different PR/MR.
  if (found.length === 0)
    return {
      kind: 'none',
      reason:
        requests.length === 1
          ? failed[0].reason
          : `No session target ${requestNoun(scope)} could be resolved`,
      explicitTarget: true,
      ...(scope ? { forge: scope } : {}),
    };
  return {
    kind: 'found',
    sessionTarget:
      requests.length === 1
        ? found[0].url
        : `${requests.length} ${requestPlural(scope)} set with set_session_target`,
    explicitTarget: true,
    requests: found,
    ...(failed.length ? { failed } : {}),
    ...(scope ? { forge: scope } : {}),
  };
}

export async function locate(forges: ForgeCatalog, hints: Hints): Promise<Lookup> {
  const { directory, targets } = hints;
  if (!targets?.length) return { kind: 'none', reason: 'No session target is set' };
  return locateTargets(forges, directory, targets, hints.previous, hints.request);
}
