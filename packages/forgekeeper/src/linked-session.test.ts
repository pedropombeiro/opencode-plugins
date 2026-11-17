import { describe, expect, test } from 'bun:test';
import { linkedMetadata, linkedOwner, type DirectorySession } from './linked-session';

const session = (id: string, extra: Partial<DirectorySession> = {}): DirectorySession => ({
  id,
  time: { idle: 5 },
  ...extra,
});

describe('linkedOwner', () => {
  test('names the owner of a linked session, and of no fork or other session', () => {
    expect(linkedOwner(session('s2', { metadata: linkedMetadata('s1', 'b', 's2') }))).toBe('s1');
    expect(linkedOwner(session('s2', { metadata: linkedMetadata('s1', 'b') }))).toBe('s1');
    expect(
      linkedOwner(session('s3', { metadata: linkedMetadata('s1', 'b', 's2'), fork: {} })),
    ).toBeUndefined();
    expect(
      linkedOwner(session('s3', { metadata: linkedMetadata('s1', 'b'), fork: {} })),
    ).toBeUndefined();
    expect(linkedOwner(session('s1'))).toBeUndefined();
  });
});
