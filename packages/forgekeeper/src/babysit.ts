import { automatedReview } from './automated-review-watch';
import type { ReviewRequest } from './forge';
import { reference, traitsOf } from './forges';
import type { Lookup } from './store';
import { includesRequest } from './target';

// What the babysitter last saw of one PR/MR. `observed` is unset until the
// first lookup after babysitting starts, which only records a baseline.
export type ItemState = { observed?: boolean; sha?: string; ci?: string; conflicts?: boolean };

// A session's babysitting, stored per session. `items` is keyed by target URL.
export type BabysitRecord = {
  directory: string;
  started: number;
  items: Record<string, ItemState>;
};

export type BabysitEventKind = 'ci-failed' | 'ci-canceled' | 'conflict' | 'ready' | 'closed';

export interface BabysitEvent {
  kind: BabysitEventKind;
  url: string;
  request: ReviewRequest;
}

// Events that end babysitting for their PR/MR.
const FINAL = new Set<BabysitEventKind>(['ready', 'closed']);

const conflicted = (request: ReviewRequest) => request.conflictsKnown && request.conflicts;

// Green CI for the current head, no known conflict, no unresolved thread, and
// no automated review still running.
export function isReady(request: ReviewRequest): boolean {
  return (
    request.state === 'opened' &&
    request.pipeline?.status === 'SUCCESS' &&
    request.conflictsKnown &&
    !request.conflicts &&
    request.threadsComplete &&
    request.unresolvedThreads === 0 &&
    automatedReview(request)?.state !== 'running'
  );
}

// Compares a PR/MR with what the babysitter saw last. CI results are reported
// once per head commit and status, so a retry that fails again is reported
// again, but an old failure is not reported after a push.
export function evaluate(
  state: ItemState,
  request: ReviewRequest,
): { next: ItemState; events: BabysitEventKind[] } {
  const sha = request.headSha;
  const ci = request.pipeline?.status;
  const next: ItemState = {
    observed: true,
    ...(sha ? { sha } : {}),
    ...(ci ? { ci } : {}),
    ...(conflicted(request) ? { conflicts: true } : {}),
  };
  if (request.state !== 'opened') return { next, events: ['closed'] };
  if (isReady(request)) return { next, events: ['ready'] };
  if (!state.observed) return { next, events: [] };

  const events: BabysitEventKind[] = [];
  const changed = ci !== state.ci || sha !== state.sha;
  if (changed && ci === 'FAILED') events.push('ci-failed');
  if (changed && ci === 'CANCELED') events.push('ci-canceled');
  if (conflicted(request) && !state.conflicts) events.push('conflict');
  return { next, events };
}

const shortSha = (request: ReviewRequest) =>
  request.headSha ? ` at ${request.headSha.slice(0, 8)}` : '';

function describe(event: BabysitEvent): string {
  const { request } = event;
  const ci = traitsOf(request).ci;
  switch (event.kind) {
    case 'ci-failed':
      return `the ${ci} failed${shortSha(request)}${request.pipeline?.url ? ` (${request.pipeline.url})` : ''}`;
    case 'ci-canceled':
      return `the ${ci} was canceled${shortSha(request)}`;
    case 'conflict':
      return 'it has merge conflicts with its target branch';
    case 'ready':
      return `it looks ready for human review: the ${ci} passed, with no unresolved threads or conflicts. Stopped babysitting it`;
    case 'closed':
      return `it was ${request.state}. Stopped babysitting it`;
  }
}

const label = (request: ReviewRequest) => `${reference(request)} (${request.url})`;

// The message that resumes the session about the events, in order.
export function babysitMessage(events: BabysitEvent[], remaining: readonly string[]) {
  const lines = [
    'Babysitting update:',
    ...events.map((event) => `- ${label(event.request)}: ${describe(event)}.`),
  ];
  if (remaining.length === 0) {
    lines.push(
      'Babysitting is finished: every PR/MR is ready for review or closed. Summarize the outcome for the user.',
    );
  } else {
    lines.push(
      'Handle what needs attention as the /babysit instructions describe, then end your turn. Forgekeeper keeps watching the rest.',
    );
  }
  return lines.join('\n');
}

export function babysitTitle(events: BabysitEvent[]): string {
  const references = [...new Set(events.map((event) => reference(event.request)))];
  return `Babysitting update for ${references.join(', ')}`;
}

// The instructions that start babysitting. Forge-neutral, so the plugin makes
// sense outside any one team's workflow. `skill` names an installed skill
// that adds workflow-specific rules.
export function startPrompt(urls: readonly string[], skill?: string): string {
  return [
    'Babysit these PRs/MRs until they are ready for human review:',
    ...urls.map((url) => `- ${url}`),
    '',
    ...(skill
      ? [
          `Load the \`${skill}\` skill and follow it for each PR/MR. Where it tells you to poll or wait for CI, rely on the notifications below instead.`,
          '',
        ]
      : []),
    'Forgekeeper watches them now and resumes this session when CI fails or is canceled, a merge conflict appears, review feedback arrives, or a PR/MR looks ready, merges, or closes. Do not poll, sleep, or start a watcher yourself. After you handle what needs attention, end your turn.',
    '',
    'For each PR/MR:',
    '1. Check its current CI, merge conflicts, and unresolved review threads now. Notifications only cover changes from here on.',
    '2. Retry CI jobs that failed for transient reasons, at most twice per job. Fix failures that its own changes caused, in the checkout of its source branch, synced with the remote branch.',
    '3. Address valid, in-scope review feedback. Ask the user about design decisions, scope changes, and disagreements.',
    '4. Batch changes into one push per PR/MR per cycle, because every push starts new CI and reviews. Do not force-push, merge, approve, or change reviewers.',
    '5. Follow the user’s instructions about posting replies and resolving threads. Without any, ask before posting.',
    '6. When a PR/MR needs the user, or 5 rounds of fixes made no progress, call babysit with operation "stop" and its URL, and explain why.',
  ].join('\n');
}

export interface BabysitterOptions {
  directory: string;
  read: (sessionID: string) => Promise<BabysitRecord | undefined>;
  write: (sessionID: string, record: BabysitRecord | undefined) => Promise<void>;
  // Every stored record, from every checkout.
  scan: () => Promise<{ sessionID: string; record: BabysitRecord }[]>;
  // Tells the session about the requests that are still its targets, and
  // returns them. Rejects when the session couldn't be told.
  send: (
    sessionID: string,
    requests: ReviewRequest[],
    compose: (requests: ReviewRequest[]) => { text: string; description: string },
  ) => Promise<ReviewRequest[]>;
  onSendError?: (error: unknown, sessionID: string) => void;
  // After the PRs/MRs a session babysits changed, from a start, a stop, or a
  // PR/MR that finished. It must not wait for the babysitter, which is busy
  // with the change that called it.
  changed?: (sessionID: string) => void;
  now?: () => number;
}

export type Babysitter = ReturnType<typeof createBabysitter>;

// Tracks which of a session's PRs/MRs it babysits, and tells the session when
// one of them needs attention, is ready, or closes. The poll that observes
// them belongs to the status service.
export function createBabysitter(options: BabysitterOptions) {
  const now = options.now ?? Date.now;
  const records = new Map<string, BabysitRecord | undefined>();
  const chains = new Map<string, Promise<unknown>>();

  // Runs one change at a time per session.
  function serial<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
    const next = (chains.get(sessionID) ?? Promise.resolve()).then(task);
    const settled = next.catch(() => {});
    chains.set(sessionID, settled);
    void settled.then(() => {
      if (chains.get(sessionID) === settled) chains.delete(sessionID);
    });
    return next;
  }

  // The PRs/MRs each session babysat when `changed` last ran or its record
  // was loaded. Changes edit a loaded record in place, so the record itself
  // can't show what was different.
  const babysat = new Map<string, string>();
  const urlsOf = (record: BabysitRecord | undefined) =>
    Object.keys(record?.items ?? {})
      .sort()
      .join('\n');

  async function load(sessionID: string) {
    if (!records.has(sessionID)) {
      const record = await options.read(sessionID);
      records.set(sessionID, record);
      babysat.set(sessionID, urlsOf(record));
    }
    return records.get(sessionID);
  }

  async function store(sessionID: string, record: BabysitRecord | undefined) {
    const value = record && Object.keys(record.items).length ? record : undefined;
    records.set(sessionID, value);
    await options.write(sessionID, value);
    const urls = urlsOf(value);
    if (urls !== (babysat.get(sessionID) ?? '')) {
      babysat.set(sessionID, urls);
      options.changed?.(sessionID);
    }
    return value;
  }

  return {
    // Loads the records of this checkout's sessions, and returns their IDs.
    async restore(): Promise<string[]> {
      const ids: string[] = [];
      for (const { sessionID, record } of await options.scan()) {
        if (record.directory !== options.directory) continue;
        records.set(sessionID, record);
        babysat.set(sessionID, urlsOf(record));
        ids.push(sessionID);
      }
      return ids;
    },
    // Whether the session babysits anything, from what this instance knows.
    active: (sessionID: string) => Object.keys(records.get(sessionID)?.items ?? {}).length > 0,
    get: (sessionID: string) => serial(sessionID, () => load(sessionID)),
    // Starts babysitting `urls`, except those that another session babysits.
    start: (sessionID: string, urls: readonly string[]) =>
      serial(sessionID, async () => {
        const others = (await options.scan()).filter((entry) => entry.sessionID !== sessionID);
        const claimed: { url: string; sessionID: string }[] = [];
        const added: string[] = [];
        const record = (await load(sessionID)) ?? {
          directory: options.directory,
          started: now(),
          items: {},
        };
        for (const url of urls) {
          const owner = others.find((entry) => url in entry.record.items);
          if (owner) claimed.push({ url, sessionID: owner.sessionID });
          else {
            // Starting again resets the baseline, so the new instructions
            // cover the current state.
            record.items[url] = {};
            added.push(url);
          }
        }
        await store(sessionID, { ...record, directory: options.directory });
        return { added, claimed };
      }),
    // Stops babysitting `urls`, or everything without them. Returns what stopped.
    stop: (sessionID: string, urls?: readonly string[]) =>
      serial(sessionID, async () => {
        const record = await load(sessionID);
        if (!record) return [];
        const stopped = Object.keys(record.items).filter((url) => !urls || urls.includes(url));
        for (const url of stopped) delete record.items[url];
        await store(sessionID, record);
        return stopped;
      }),
    // Drops PRs/MRs that are no longer session targets.
    prune: (sessionID: string, isTarget: (url: string) => boolean) =>
      serial(sessionID, async () => {
        const record = await load(sessionID);
        if (!record) return;
        const gone = Object.keys(record.items).filter((url) => !isTarget(url));
        if (gone.length === 0) return;
        for (const url of gone) delete record.items[url];
        await store(sessionID, record);
      }),
    // Forgets a session that moved to another checkout, so it's read again if it comes back.
    forget: (sessionID: string) => {
      records.delete(sessionID);
      babysat.delete(sessionID);
    },
    // Compares the lookup with what was seen last, and tells the session about changes.
    observe: (sessionID: string, lookup: Lookup) =>
      serial(sessionID, async () => {
        const record = await load(sessionID);
        if (!record || lookup.kind !== 'found') return;
        const events: BabysitEvent[] = [];
        const next = { ...record.items };
        for (const [url, state] of Object.entries(record.items)) {
          const request = lookup.requests.find((candidate) =>
            includesRequest([{ url }], candidate.url),
          );
          if (!request) continue;
          const result = evaluate(state, request);
          next[url] = result.next;
          for (const kind of result.events) events.push({ kind, url, request });
        }

        const unchanged = JSON.stringify(next) === JSON.stringify(record.items);
        if (events.length === 0) {
          if (!unchanged) await store(sessionID, { ...record, items: next });
          return;
        }

        const finished = new Set(
          events.filter((event) => FINAL.has(event.kind)).map((event) => event.url),
        );
        const remaining = Object.keys(next).filter((url) => !finished.has(url));
        try {
          const sent = await options.send(
            sessionID,
            events.map((event) => event.request),
            (current) => {
              const shown = events.filter((event) => current.includes(event.request));
              return { text: babysitMessage(shown, remaining), description: babysitTitle(shown) };
            },
          );
          const told = new Set(sent);
          for (const event of events) {
            if (FINAL.has(event.kind) || !told.has(event.request)) delete next[event.url];
          }
        } catch (error) {
          // Keeps what was seen before the events, so the next poll reports
          // them again.
          for (const event of events) next[event.url] = record.items[event.url];
          options.onSendError?.(error, sessionID);
        }
        await store(sessionID, { ...record, items: next });
      }),
  };
}
