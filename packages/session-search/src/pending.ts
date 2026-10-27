import type { OpenAction } from './rpc.ts';

const waiting = new Map<string, (action: OpenAction | undefined) => void>();

export function waitForReply(
  requestID: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OpenAction | undefined> {
  return new Promise((resolve) => {
    const finish = (action: OpenAction | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      waiting.delete(requestID);
      resolve(action);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    waiting.set(requestID, finish);
  });
}

export function reply(requestID: string, action: OpenAction): boolean {
  const finish = waiting.get(requestID);
  if (!finish) return false;
  finish(action);
  return true;
}
