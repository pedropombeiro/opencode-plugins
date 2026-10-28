import type { Exec } from './exec';
import type { ReviewFeedback, ReviewRequest } from './forge';
import { traitsOf } from './forges';
import { SubscriptionRateLimit } from './subscription-retry';

export const RECONCILE_INTERVAL = 15 * 60_000;

export interface SubscriptionStatus {
  state: 'inactive' | 'polling-only' | 'connecting' | 'connected' | 'waiting';
  retryAt?: number;
  cooldownUntil?: number;
  error?: { message: string; at: number };
}

export function createFeedbackSubscriptions(options: {
  exec: Exec;
  directory: string;
  changed: (url: string) => void;
  capability?: (request: ReviewRequest) => ReviewFeedback['subscribe'];
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cooldowns = new Map<string, number>();
  const sessions = new Map<string, ReviewRequest[]>();
  const entries = new Map<
    string,
    {
      abort: AbortController;
      connected: boolean;
      timer?: unknown;
      failures: number;
      retryAt?: number;
      error?: { message: string; at: number };
    }
  >();
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;

  function reconcile() {
    const wanted = new Map([...sessions.values()].flat().map((request) => [request.url, request]));
    for (const [url, entry] of entries) {
      if (wanted.has(url)) continue;
      entries.delete(url);
      entry.abort.abort();
      if (entry.timer !== undefined) clearTimer(entry.timer);
    }
    for (const [url, request] of wanted) {
      if (entries.has(url)) continue;
      const subscribe = options.capability
        ? options.capability(request)
        : traitsOf(request).feedback?.subscribe;
      if (!subscribe) continue;
      const entry = {
        abort: new AbortController(),
        connected: false,
        failures: 0,
        timer: undefined as unknown,
        retryAt: undefined as number | undefined,
        error: undefined as SubscriptionStatus['error'],
      };
      entries.set(url, entry);
      const live = () => !stopped && entries.get(url) === entry;
      const host = new URL(url).origin;
      const schedule = (delay: number) => {
        entry.retryAt = now() + delay;
        entry.timer = setTimer(() => void connect(), Math.min(delay, 2_147_483_647));
      };
      const connect = async () => {
        if (!live()) return;
        entry.timer = undefined;
        entry.retryAt = undefined;
        const remaining = (cooldowns.get(host) ?? 0) - now();
        if (remaining > 0) {
          schedule(remaining);
          return;
        }
        cooldowns.delete(host);
        try {
          await subscribe(
            options.exec,
            options.directory,
            request,
            {
              connected: () => {
                if (!live()) return;
                entry.connected = true;
                entry.error = undefined;
                options.changed(url);
              },
              changed: () => {
                if (live()) options.changed(url);
              },
            },
            entry.abort.signal,
          );
        } catch (error) {
          if (live())
            entry.error = {
              message: error instanceof Error ? error.message : String(error),
              at: now(),
            };
          if (live() && error instanceof SubscriptionRateLimit && Number.isFinite(error.retryAt))
            cooldowns.set(host, Math.max(cooldowns.get(host) ?? 0, error.retryAt));
          entry.connected = false;
        } finally {
          entry.connected = false;
          if (live()) {
            const delay = Math.min(30_000 * 2 ** Math.min(entry.failures++, 5), RECONCILE_INTERVAL);
            schedule(Math.max(delay, (cooldowns.get(host) ?? 0) - now()));
          }
        }
      };
      void connect();
    }
  }

  return {
    update(sessionID: string, requests: ReviewRequest[]) {
      if (stopped) return;
      if (requests.length) sessions.set(sessionID, requests);
      else sessions.delete(sessionID);
      reconcile();
    },
    connected: (url: string) => entries.get(url)?.connected === true,
    inspect(sessionID: string, url: string): SubscriptionStatus {
      const request = sessions.get(sessionID)?.find((request) => request.url === url);
      if (!request) return { state: 'inactive' };
      const entry = entries.get(url);
      if (!entry) return { state: 'polling-only' };
      const cooldownUntil = cooldowns.get(new URL(url).origin);
      return structuredClone({
        state: entry.connected
          ? 'connected'
          : entry.retryAt !== undefined
            ? 'waiting'
            : 'connecting',
        ...(entry.retryAt !== undefined ? { retryAt: entry.retryAt } : {}),
        ...(cooldownUntil !== undefined && cooldownUntil > now() ? { cooldownUntil } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      });
    },
    dispose() {
      stopped = true;
      sessions.clear();
      reconcile();
    },
  };
}
