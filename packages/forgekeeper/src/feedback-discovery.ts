import { mapLimit, CONCURRENCY } from './limit';
import { linkedOwner } from './linked-session';

export const RECENT_ACTIVITY = 3 * 24 * 60 * 60_000;
export const DISCOVERY_INTERVAL = 5 * 60_000;

export interface DiscoverySession {
  id?: string;
  parentID?: string;
  fork?: unknown;
  metadata?: Record<string, unknown>;
  time: { archived?: number };
  location: { directory: string };
}

export function createFeedbackDiscovery(options: {
  directory: string;
  candidates: () => Promise<string[]>;
  candidate: (id: string) => Promise<boolean>;
  session: (id: string) => Promise<DiscoverySession>;
  activity: (id: string) => Promise<number | undefined>;
  paused: () => Promise<boolean>;
  watch: (ids: string[]) => void;
  error: (error: unknown) => void;
  now?: () => number;
}) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let full = false;
  const pending = new Set<string>();
  const watched = new Set<string>();
  const refresh = (id?: string) => {
    if (stopped) return Promise.resolve();
    if (id === undefined) full = true;
    else pending.add(id);
    if (running) return running;
    running = (async () => {
      while (!stopped && (full || pending.size)) {
        const scan = full;
        full = false;
        const changed = [...pending];
        pending.clear();
        if (await options.paused()) {
          watched.clear();
          if (!stopped) options.watch([]);
          continue;
        }
        const ids = scan ? await options.candidates() : changed;
        if (scan) watched.clear();
        await mapLimit(ids, CONCURRENCY, async (id) => {
          if (stopped) return;
          try {
            watched.delete(id);
            if (!scan && !(await options.candidate(id))) return;
            const session = await options.session(id);
            if (
              session.parentID ||
              session.time.archived !== undefined ||
              session.location.directory !== options.directory ||
              linkedOwner({ ...session, id: session.id ?? id })
            )
              return;
            const activity = await options.activity(id);
            const age = (options.now ?? Date.now)() - (activity ?? -Infinity);
            if (age >= 0 && age <= RECENT_ACTIVITY) watched.add(id);
          } catch (error) {
            options.error(error);
          }
        });
        if (!stopped) options.watch([...watched]);
      }
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
