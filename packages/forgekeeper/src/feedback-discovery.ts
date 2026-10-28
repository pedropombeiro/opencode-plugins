import { mapLimit, CONCURRENCY } from './limit';

export const RECENT_ACTIVITY = 3 * 24 * 60 * 60_000;
export const DISCOVERY_INTERVAL = 5 * 60_000;

export interface DiscoverySession {
  parentID?: string;
  time: { archived?: number };
  location: { directory: string };
}

export function createFeedbackDiscovery(options: {
  directory: string;
  candidates: () => Promise<string[]>;
  session: (id: string) => Promise<DiscoverySession>;
  activity: (id: string) => Promise<number | undefined>;
  paused: () => Promise<boolean>;
  watch: (ids: string[]) => void;
  error: (error: unknown) => void;
  now?: () => number;
}) {
  let stopped = false;
  let running: Promise<void> | undefined;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      if (await options.paused()) {
        if (!stopped) options.watch([]);
        return;
      }
      const ids: string[] = [];
      await mapLimit(await options.candidates(), CONCURRENCY, async (id) => {
        if (stopped) return;
        try {
          const session = await options.session(id);
          if (
            session.parentID ||
            session.time.archived !== undefined ||
            session.location.directory !== options.directory
          )
            return;
          const activity = await options.activity(id);
          const age = (options.now ?? Date.now)() - (activity ?? -Infinity);
          if (age >= 0 && age <= RECENT_ACTIVITY) ids.push(id);
        } catch (error) {
          options.error(error);
        }
      });
      if (!stopped) options.watch(ids);
    })()
      .catch(options.error)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  return {
    refresh,
    stop: () => {
      stopped = true;
    },
  };
}
