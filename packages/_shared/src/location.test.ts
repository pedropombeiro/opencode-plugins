import { describe, expect, test } from 'bun:test';
import { createLocationFilter, eventSessionID } from './location.ts';
import type { OpenCodeEvent } from './opencode.ts';

function event(type: string, data: Record<string, unknown>, directory?: string): OpenCodeEvent {
  return {
    type,
    data,
    ...(directory ? { location: { directory } } : {}),
  } as unknown as OpenCodeEvent;
}

describe('eventSessionID', () => {
  test('reads the session from the event data or its form', () => {
    expect(eventSessionID(event('session.idle', { sessionID: 'ses_1' }))).toBe('ses_1');
    expect(eventSessionID(event('form.created', { form: { sessionID: 'ses_2' } }))).toBe('ses_2');
    expect(eventSessionID(event('config.updated', {}))).toBeUndefined();
  });
});

describe('createLocationFilter', () => {
  test('uses the event location when it is present', async () => {
    const lookups: string[] = [];
    const owns = createLocationFilter('/work/a', async (sessionID) => {
      lookups.push(sessionID);
      return undefined;
    });

    expect(await owns(event('permission.asked', { sessionID: 'ses_a' }, '/work/a'))).toBe(true);
    expect(await owns(event('permission.asked', { sessionID: 'ses_b' }, '/work/b'))).toBe(false);
    expect(lookups).toEqual([]);
  });

  test('remembers a session location for events that do not carry one', async () => {
    const lookups: string[] = [];
    const owns = createLocationFilter('/work/a', async (sessionID) => {
      lookups.push(sessionID);
      return '/work/b';
    });

    await owns(event('session.step.started', { sessionID: 'ses_a' }, '/work/a'));

    expect(await owns(event('session.execution.succeeded', { sessionID: 'ses_a' }))).toBe(true);
    expect(lookups).toEqual([]);
  });

  test('looks up an unknown session once', async () => {
    const lookups: string[] = [];
    const owns = createLocationFilter('/work/a', async (sessionID) => {
      lookups.push(sessionID);
      return sessionID === 'ses_a' ? '/work/a' : '/work/b';
    });

    expect(await owns(event('session.execution.started', { sessionID: 'ses_a' }))).toBe(true);
    expect(await owns(event('session.execution.succeeded', { sessionID: 'ses_a' }))).toBe(true);
    expect(await owns(event('session.execution.started', { sessionID: 'ses_b' }))).toBe(false);
    expect(lookups).toEqual(['ses_a', 'ses_b']);
  });

  test('retries a lookup that failed', async () => {
    let attempts = 0;
    const owns = createLocationFilter('/work/a', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('not ready');
      return '/work/a';
    });
    const started = event('session.execution.started', { sessionID: 'ses_a' });

    expect(await owns(started)).toBe(false);
    expect(await owns(started)).toBe(true);
  });

  test('ignores events without a session', async () => {
    const owns = createLocationFilter('/work/a', async () => '/work/a');

    expect(await owns(event('config.updated', {}, '/work/a'))).toBe(false);
  });
});
