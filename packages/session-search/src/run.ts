import type { Result, SearchOptions } from './db.ts';

type Reply = { result: Result } | { error: string };

export function workerURL(base: string = import.meta.url): URL {
  const typescript = new URL(base).pathname.endsWith('.ts');
  return new URL(typescript ? './worker.ts' : './worker.js', base);
}

export function runSearch(
  options: SearchOptions,
  signal?: AbortSignal,
  url: URL = workerURL(),
): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Search cancelled'));
      return;
    }
    const worker = new Worker(url);
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      finish();
    };
    const abort = () => settle(() => reject(new Error('Search cancelled')));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      settle(() => ('error' in reply ? reject(new Error(reply.error)) : resolve(reply.result)));
    };
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'Search worker failed')));
    };
    worker.addEventListener('close', (event) => {
      const code = (event as Event & { code?: number }).code;
      settle(() => reject(new Error(`Search worker exited (code ${code ?? 'unknown'})`)));
    });
    worker.postMessage(options);
  });
}
