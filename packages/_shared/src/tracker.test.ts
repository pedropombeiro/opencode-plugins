import { describe, expect, test } from 'bun:test';
import type { OpenCodeEvent } from './opencode.ts';
import { createAgentStateTracker } from './tracker.ts';
import type { WaitingDetail } from './waiting.ts';

const sessionID = 'ses_1';

function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return { type, data } as unknown as OpenCodeEvent;
}

const busy = event('session.status', { sessionID, status: { type: 'busy' } });
const idle = event('session.status', { sessionID, status: { type: 'idle' } });

function permissionAsked(id: string, resources = ['git status']): OpenCodeEvent {
  return event('permission.asked', { id, sessionID, action: 'bash', resources });
}

function formCreated(id: string): OpenCodeEvent {
  return event('form.created', {
    form: {
      id,
      sessionID,
      title: 'Pick one',
      fields: [
        {
          type: 'string',
          key: 'choice',
          title: 'Choice',
          description: 'Which option?',
          options: [
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B', description: 'The second one' },
          ],
        },
        { type: 'boolean', key: 'secret', hidden: true },
      ],
    },
  });
}

function record() {
  const calls: string[] = [];
  const details: WaitingDetail[] = [];
  const tracker = createAgentStateTracker({
    onWaiting: (id, detail) => {
      calls.push(`waiting:${id}:${detail.id}`);
      details.push(detail);
    },
    onResolved: (id, requestID) => {
      calls.push(`resolved:${id}:${requestID}`);
    },
    onBusy: (id) => {
      calls.push(`busy:${id}`);
    },
    onIdle: (id) => {
      calls.push(`idle:${id}`);
    },
    onError: (id) => {
      calls.push(`error:${id}`);
    },
  });
  return { tracker, calls, details };
}

describe('createAgentStateTracker', () => {
  test('reports busy and idle transitions once', async () => {
    const { tracker, calls } = record();

    await tracker.handle(busy);
    await tracker.handle(busy);
    await tracker.handle(idle);
    await tracker.handle(event('session.idle', { sessionID }));

    expect(calls).toEqual(['busy:ses_1', 'idle:ses_1']);
  });

  test('follows the execution lifecycle', async () => {
    const { tracker, calls } = record();

    await tracker.handle(event('session.execution.started', { sessionID }));
    await tracker.handle(event('session.execution.succeeded', { sessionID }));
    await tracker.handle(event('session.execution.started', { sessionID }));
    await tracker.handle(event('session.execution.interrupted', { sessionID }));

    expect(calls).toEqual(['busy:ses_1', 'idle:ses_1', 'busy:ses_1', 'idle:ses_1']);
  });

  test('treats each step as a busy heartbeat when repeated busy is requested', async () => {
    const calls: string[] = [];
    const tracker = createAgentStateTracker({
      emitRepeatedBusy: true,
      onBusy: (id) => {
        calls.push(id);
      },
    });

    await tracker.handle(event('session.step.started', { sessionID }));
    await tracker.handle(event('session.execution.started', { sessionID }));
    await tracker.handle(event('session.step.started', { sessionID }));
    await tracker.handle(permissionAsked('per_1'));
    await tracker.handle(event('session.step.started', { sessionID }));

    expect(calls).toEqual(['ses_1', 'ses_1']);
  });

  test('ignores steps unless repeated busy is requested', async () => {
    const { tracker, calls } = record();

    await tracker.handle(event('session.execution.started', { sessionID }));
    await tracker.handle(event('session.step.started', { sessionID }));

    expect(calls).toEqual(['busy:ses_1']);
  });

  test('repeats busy notifications when requested', async () => {
    const calls: string[] = [];
    const tracker = createAgentStateTracker({
      emitRepeatedBusy: true,
      onBusy: (id) => {
        calls.push(id);
      },
    });

    await tracker.handle(busy);
    await tracker.handle(busy);

    expect(calls).toEqual(['ses_1', 'ses_1']);
  });

  test('reports a failed execution as an error', async () => {
    const { tracker, calls } = record();

    await tracker.handle(busy);
    await tracker.handle(event('session.execution.failed', { sessionID, error: {} }));
    await tracker.handle(idle);

    expect(calls).toEqual(['busy:ses_1', 'error:ses_1']);
  });

  test('waits on a permission request until it is replied to', async () => {
    const { tracker, calls, details } = record();

    await tracker.handle(busy);
    await tracker.handle(permissionAsked('per_1'));
    expect(tracker.hasWait(sessionID)).toBe(true);

    await tracker.handle(busy);
    await tracker.handle(event('permission.replied', { sessionID, requestID: 'per_1' }));

    expect(tracker.hasWait(sessionID)).toBe(false);
    expect(calls).toEqual([
      'busy:ses_1',
      'waiting:ses_1:per_1',
      'resolved:ses_1:per_1',
      'busy:ses_1',
    ]);
    expect(details[0]).toEqual({
      reason: 'permission',
      id: 'per_1',
      type: 'bash',
      title: 'bash: git status',
      pattern: ['git status'],
    });
  });

  test('describes a form as a question', async () => {
    const { tracker, details } = record();

    await tracker.handle(formCreated('frm_1'));

    expect(details[0]).toEqual({
      reason: 'question',
      id: 'frm_1',
      title: 'Pick one',
      questions: [
        {
          header: 'Choice',
          question: 'Which option?',
          options: [
            { label: 'Option A', value: 'a', description: undefined },
            { label: 'Option B', value: 'b', description: 'The second one' },
          ],
          multiple: undefined,
        },
      ],
    });
  });

  test('stops waiting when a form is replied to or cancelled', async () => {
    const { tracker, calls } = record();

    await tracker.handle(busy);
    await tracker.handle(formCreated('frm_1'));
    await tracker.handle(formCreated('frm_2'));
    await tracker.handle(event('form.replied', { id: 'frm_1', sessionID, answer: {} }));
    expect(tracker.hasWait(sessionID)).toBe(true);
    await tracker.handle(event('form.cancelled', { id: 'frm_2', sessionID }));

    expect(tracker.hasWait(sessionID)).toBe(false);
    expect(calls.slice(-3)).toEqual(['resolved:ses_1:frm_1', 'resolved:ses_1:frm_2', 'busy:ses_1']);
  });

  test('ignores replies to requests it is not waiting on', async () => {
    const { tracker, calls } = record();

    await tracker.handle(event('permission.replied', { sessionID, requestID: 'per_x' }));
    await tracker.handle(event('form.cancelled', { id: 'frm_x', sessionID }));

    expect(calls).toEqual([]);
  });

  test('clears waits when the session goes idle', async () => {
    const { tracker, calls } = record();

    await tracker.handle(busy);
    await tracker.handle(permissionAsked('per_1'));
    await tracker.handle(idle);

    expect(tracker.hasWait(sessionID)).toBe(false);
    expect(calls.at(-1)).toBe('idle:ses_1');
  });

  test('accepts a permission request after idle without an intervening busy event', async () => {
    const { tracker, calls } = record();

    await tracker.handle(busy);
    await tracker.handle(permissionAsked('per_1', ['first']));
    await tracker.handle(idle);
    await tracker.handle(permissionAsked('per_2', ['second']));

    expect(calls.filter((call) => call.startsWith('waiting'))).toEqual([
      'waiting:ses_1:per_1',
      'waiting:ses_1:per_2',
    ]);
  });
});
