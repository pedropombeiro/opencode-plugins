import type { Result } from './db.ts';
import { LIMIT, withTitleMatches } from './present.ts';
import type { SearchRequest } from './rpc.ts';

const SEARCH_TIMEOUT_MS = 120_000;

export interface DesktopSearchState {
  query: string;
  result?: Result;
  titleCount: number;
  searching: boolean;
  error?: string;
}

export function createDesktopSearch(
  search: (request: SearchRequest, signal: AbortSignal) => Promise<Result>,
  update: (state: DesktopSearchState) => void,
) {
  let active: AbortController | undefined;

  function cancel() {
    active?.abort();
    active = undefined;
  }

  async function run(input: string) {
    cancel();
    const query = input.trim();
    update({ query, titleCount: 0, searching: !!query });
    if (!query) return;

    const request = (active = new AbortController());
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
    const body = { query, limit: LIMIT };
    let preview: Result | undefined;
    void Promise.resolve()
      .then(() => (signal.aborted ? undefined : search({ ...body, titles: true }, signal)))
      .then((result) => {
        if (active !== request || signal.aborted || !result?.sessions.length) return;
        preview = result;
        update({ query, result, titleCount: result.sessions.length, searching: true });
      })
      .catch(() => {});
    try {
      const full = await search(body, signal);
      if (active !== request) return;
      const result = preview ? withTitleMatches(full, preview) : full;
      update({ query, result, titleCount: preview?.sessions.length ?? 0, searching: false });
    } catch (error) {
      if (active !== request) return;
      update({
        query,
        result: preview,
        titleCount: preview?.sessions.length ?? 0,
        searching: false,
        error:
          error && typeof error === 'object' && 'message' in error
            ? String(error.message)
            : String(error),
      });
    } finally {
      if (active === request) cancel();
    }
  }

  return { cancel, run };
}
