import { mapLimit, CONCURRENCY } from './limit';
import { linkedOwner } from './linked-session';

export const RECENT_ACTIVITY = 3 * 24 * 60 * 60_000;
export const DISCOVERY_INTERVAL = 5 * 60_000;
const RECONCILE_INTERVAL = 24 * 60 * 60_000;

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
  missing?: (error: unknown) => boolean;
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
  const activityBySession = new Map<string, number>();
  const retry = new Set<string>();
  let scannedAt: number | undefined;
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
          scannedAt = undefined;
          activityBySession.clear();
          retry.clear();
          if (!stopped) options.watch([]);
          continue;
        }
        const at = (options.now ?? Date.now)();
        const rebuild =
          scan &&
          (scannedAt === undefined || at - scannedAt >= RECONCILE_INTERVAL || at < scannedAt);
        const ids = rebuild
          ? await options.candidates()
          : new Set([...changed, ...(scan ? retry : [])]);
        if (rebuild) {
          activityBySession.clear();
          retry.clear();
          scannedAt = at;
        }
        await mapLimit([...ids], CONCURRENCY, async (id) => {
          if (stopped) return;
          try {
            activityBySession.delete(id);
            retry.delete(id);
            if (!rebuild && !(await options.candidate(id))) return;
            const session = await options.session(id);
            if (
              session.parentID ||
              session.time.archived !== undefined ||
              session.location.directory !== options.directory ||
              linkedOwner({ ...session, id: session.id ?? id })
            )
              return;
            const activity = await options.activity(id);
            if (activity !== undefined) activityBySession.set(id, activity);
          } catch (error) {
            if (options.missing?.(error)) return;
            retry.add(id);
            options.error(error);
          }
        });
        const watched: string[] = [];
        const now = (options.now ?? Date.now)();
        for (const [id, activity] of activityBySession) {
          if (now - activity > RECENT_ACTIVITY) activityBySession.delete(id);
          else if (activity <= now) watched.push(id);
        }
        if (!stopped) options.watch(watched);
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
