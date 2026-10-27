import { searchSessions, type SearchOptions } from './db.ts';

declare const self: Worker;

self.onmessage = (event: MessageEvent<SearchOptions>) => {
  try {
    self.postMessage({ result: searchSessions(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
