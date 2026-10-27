import { realpathSync } from 'node:fs';

export interface SessionRef {
  id: string;
  projectID: string;
  parentID?: string;
  location: { directory: string };
}

export const GLOBAL_PROJECT = 'global';

function resolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, '');
  }
}

export function sameProject(
  a: SessionRef,
  b: SessionRef,
  resolvePath: (path: string) => string = resolve,
): boolean {
  if (a.projectID !== b.projectID) return false;
  if (a.projectID !== GLOBAL_PROJECT) return true;
  return resolvePath(a.location.directory) === resolvePath(b.location.directory);
}

export function rejectReason(
  source: SessionRef,
  target: SessionRef,
  resolvePath?: (path: string) => string,
): string | undefined {
  if (source.id === target.id) return 'That is the current session.';
  if (!sameProject(source, target, resolvePath)) {
    return (
      `Session ${target.id} belongs to another project (${target.location.directory}). ` +
      `Reopen it with \`opencode --session ${target.id}\`.`
    );
  }
  return undefined;
}
