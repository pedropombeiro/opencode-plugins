export interface FeedbackItem {
  id: string;
  sessionID: string;
  url: string;
  title: string;
  links: string[];
  at: number;
}

export interface InboxState {
  items: FeedbackItem[];
  paused: boolean;
}

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

export function createFeedbackInbox(options: {
  read: () => Promise<InboxState | undefined>;
  write: (state: InboxState) => Promise<void>;
  changed: () => void;
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
  return {
    list: () => run(read),
    add: (item: FeedbackItem) =>
      change(
        (state) => ({
          ...state,
          items: [item, ...state.items.filter((entry) => entry.id !== item.id)].slice(0, 500),
        }),
        true,
      ),
    acknowledge: (id: string) =>
      change((state) => ({ ...state, items: state.items.filter((item) => item.id !== id) })),
    pause: (paused: boolean) => change((state) => ({ ...state, paused })),
  };
}
