import type { OpenCodeEvent } from './opencode.ts';

type SessionDirectoryLookup = (sessionID: string) => Promise<string | undefined>;

interface EventShape {
  location?: { directory?: unknown };
  data?: { sessionID?: unknown; form?: { sessionID?: unknown } };
}

export function eventSessionID(event: OpenCodeEvent): string | undefined {
  const data = (event as EventShape).data;
  if (typeof data?.sessionID === 'string') return data.sessionID;
  const formSessionID = data?.form?.sessionID;
  return typeof formSessionID === 'string' ? formSessionID : undefined;
}

export function createLocationFilter(directory: string, lookup: SessionDirectoryLookup) {
  const directories = new Map<string, Promise<string | undefined>>();

  function sessionDirectory(sessionID: string, event: OpenCodeEvent): Promise<string | undefined> {
    const location = (event as EventShape).location?.directory;
    if (typeof location === 'string') {
      const known = Promise.resolve(location);
      directories.set(sessionID, known);
      return known;
    }

    const cached = directories.get(sessionID);
    if (cached) return cached;

    const lookedUp = lookup(sessionID).then(
      (result) => {
        if (result === undefined) directories.delete(sessionID);
        return result;
      },
      () => {
        directories.delete(sessionID);
        return undefined;
      },
    );
    directories.set(sessionID, lookedUp);
    return lookedUp;
  }

  return async function owns(event: OpenCodeEvent): Promise<boolean> {
    const sessionID = eventSessionID(event);
    if (!sessionID) return false;
    return (await sessionDirectory(sessionID, event)) === directory;
  };
}
