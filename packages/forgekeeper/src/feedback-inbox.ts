export interface FeedbackItem {
  id: string;
  sessionID: string;
  url: string;
  title: string;
  links: string[];
  // The announced comments, for summarizing them. Copilot reviews have none.
  commentIDs?: string[];
  // When the newest of those comments was last written, in milliseconds.
  postedAt?: number;
  // Lifecycle events: the PR/MR started to conflict, its pipeline got a
  // failed job, or it merged. Absent for review feedback.
  kind?: 'conflict' | 'merged' | 'ci-failed';
  // The pipeline a `ci-failed` update is about, so it clears once another
  // pipeline replaces it or it no longer fails.
  pipeline?: string;
  // What Forgekeeper knows or did about a lifecycle event, from forge data,
  // one sentence each, such as dependent PRs/MRs and their new targets.
  details?: string[];
  // How the update reaches its session, as the mode was when it was recorded.
  // Absent in inbox mode, so the update never starts a turn later.
  delivery?: 'passive' | 'summary';
  // When Forgekeeper recorded the update.
  at: number;
  notifiedAt?: number;
}

export interface InboxState {
  items: FeedbackItem[];
  paused: boolean;
}

// An absolute local time with its zone, which stays meaningful in a session's
// history, unlike a relative one such as "5 minutes ago".
export const formatTime = (at: number) =>
  new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);

// When an update's feedback happened: its newest comment, or for updates
// without comments, such as Copilot reviews, when Forgekeeper recorded it.
export const feedbackTime = (item: Pick<FeedbackItem, 'postedAt' | 'at'>) =>
  item.postedAt !== undefined
    ? `Latest comment: ${formatTime(item.postedAt)}`
    : `Detected: ${formatTime(item.at)}`;

export function feedbackLinks(item: Pick<FeedbackItem, 'url' | 'links'>): string[] {
  return [...new Set([item.url, ...item.links])].filter((url) => {
    try {
      const target = new URL(url);
      return (
        target.protocol === 'https:' &&
        target.origin === new URL(item.url).origin &&
        !target.username &&
        !target.password
      );
    } catch {
      return false;
    }
  });
}

// The links `/forge-feedback` offers for an update: its comments first, so
// Enter opens the first comment, and then the PR/MR itself. Comment links
// differ only after `#`, so their titles show that part.
export function linkOptions(item: Pick<FeedbackItem, 'url' | 'links' | 'kind'>) {
  // Every option, the PR/MR's own link included, passes the same filter.
  const links = feedbackLinks(item);
  const comments = links.filter((url) => url !== item.url);
  // A failed-job update links its jobs, named by the end of their path.
  const jobs = item.kind === 'ci-failed';
  return [
    ...comments.map((url, index) => ({
      title: `${jobs ? 'Failed job' : 'Comment'} ${comments.length > 1 ? `${index + 1} of ${comments.length} ` : ''}(${
        jobs
          ? new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/')
          : new URL(url).hash || 'no anchor'
      })`,
      description: url,
      value: url,
    })),
    ...(links.includes(item.url)
      ? [{ title: 'PR/MR overview', description: item.url, value: item.url }]
      : []),
  ];
}

export function createFeedbackInbox(options: {
  read: () => Promise<InboxState | undefined>;
  write: (state: InboxState) => Promise<void>;
  changed: () => void;
  notify?: (item: FeedbackItem) => Promise<void>;
  // Whether automatic delivery is on for the item's kind of update now. One
  // that isn't waits, undelivered, until it's on again.
  enabled?: (item: FeedbackItem) => boolean;
  now?: () => number;
}) {
  let queue = Promise.resolve();
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const read = async (): Promise<InboxState> =>
    (await options.read()) ?? { items: [], paused: false };
  const change = (update: (state: InboxState) => InboxState, adding = false) =>
    run(async () => {
      const previous = await read();
      if (adding && previous.paused) throw new Error('Feedback monitoring is paused');
      const state = update(previous);
      await options.write(state);
      options.changed();
      return state;
    });
  // Each update is delivered on its own, so one that keeps failing doesn't
  // hold back the others. Rejects with the first failure, after trying all.
  const notify = async (state: InboxState, items: FeedbackItem[]) => {
    if (!options.notify || state.paused) return state;
    let failure: { error: unknown } | undefined;
    for (const item of items) {
      if (item.notifiedAt !== undefined || !item.delivery) continue;
      if (options.enabled && !options.enabled(item)) continue;
      try {
        await options.notify(item);
      } catch (error) {
        failure ??= { error };
        continue;
      }
      state = {
        ...state,
        items: state.items.map((entry) =>
          entry.id === item.id ? { ...entry, notifiedAt: (options.now ?? Date.now)() } : entry,
        ),
      };
      await options.write(state);
    }
    if (failure) throw failure.error;
    return state;
  };
  return {
    list: () => run(read),
    add: (item: FeedbackItem) =>
      run(async () => {
        const previous = await read();
        if (previous.paused) throw new Error('Feedback monitoring is paused');
        const existing = previous.items.find((entry) => entry.id === item.id);
        const state = {
          ...previous,
          items: [
            existing ?? item,
            ...previous.items.filter((entry) => entry.id !== item.id),
          ].slice(0, 500),
        };
        await options.write(state);
        options.changed();
        return notify(state, [existing ?? item]);
      }),
    notifyPending: () =>
      run(async () => {
        const state = await read();
        return notify(state, state.items);
      }),
    acknowledge: (id: string) =>
      change((state) => ({ ...state, items: state.items.filter((item) => item.id !== id) })),
    // Removes the updates that no longer need attention, such as ones whose
    // comments were resolved. Writes, and reports a change, only when one goes.
    prune: (stale: (item: FeedbackItem) => boolean) =>
      run(async () => {
        const state = await read();
        const items = state.items.filter((item) => !stale(item));
        if (items.length === state.items.length) return state;
        const next = { ...state, items };
        await options.write(next);
        options.changed();
        return next;
      }),
    pause: (paused: boolean) => change((state) => ({ ...state, paused })),
  };
}
