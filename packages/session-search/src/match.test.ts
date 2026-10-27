import { describe, expect, test } from 'bun:test';
import { rejectReason, sameProject, type SessionRef } from './match.ts';

const identity = (path: string) => path;

function session(id: string, projectID: string, directory: string, parentID?: string): SessionRef {
  return { id, projectID, location: { directory }, ...(parentID ? { parentID } : {}) };
}

describe('sameProject', () => {
  test('matches sessions of one repository in different worktrees', () => {
    expect(
      sameProject(
        session('ses_a', 'p1', '/repo'),
        session('ses_b', 'p1', '/worktrees/task'),
        identity,
      ),
    ).toBe(true);
  });

  test('rejects sessions of different projects', () => {
    expect(
      sameProject(session('ses_a', 'p1', '/repo'), session('ses_b', 'p2', '/repo'), identity),
    ).toBe(false);
  });

  test('compares directories for sessions outside a repository', () => {
    expect(
      sameProject(
        session('ses_a', 'global', '/tmp/a'),
        session('ses_b', 'global', '/tmp/a'),
        identity,
      ),
    ).toBe(true);
    expect(
      sameProject(
        session('ses_a', 'global', '/tmp/a'),
        session('ses_b', 'global', '/tmp/b'),
        identity,
      ),
    ).toBe(false);
  });

  test('resolves directory spellings outside a repository', () => {
    const resolve = (path: string) => path.replace('/private', '');
    expect(
      sameProject(
        session('ses_a', 'global', '/private/tmp/a'),
        session('ses_b', 'global', '/tmp/a'),
        resolve,
      ),
    ).toBe(true);
  });
});

describe('rejectReason', () => {
  test('accepts another session of the same project', () => {
    expect(
      rejectReason(session('ses_a', 'p1', '/repo'), session('ses_b', 'p1', '/repo'), identity),
    ).toBeUndefined();
  });

  test('rejects the current session', () => {
    expect(
      rejectReason(session('ses_a', 'p1', '/repo'), session('ses_a', 'p1', '/repo'), identity),
    ).toContain('current session');
  });

  test('suggests reopening a session of another project', () => {
    expect(
      rejectReason(session('ses_a', 'p1', '/repo'), session('ses_b', 'p2', '/other'), identity),
    ).toContain('opencode --session ses_b');
  });
});
