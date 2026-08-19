import { describe, expect, test } from 'bun:test';
import { createAgentStateTracker } from './agent-state.ts';

describe('createAgentStateTracker', () => {
  test('accepts a permission request after idle without an intervening busy event', async () => {
    const waiting: string[] = [];
    const tracker = createAgentStateTracker({
      onWaiting: (_sessionID, detail) => {
        if (detail.id) waiting.push(detail.id);
      },
    });
    const sessionID = 'ses_1';

    await tracker.event({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });
    await tracker.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'per_1', sessionID, permission: 'bash', patterns: ['first'] },
      },
    });
    await tracker.event({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
    });
    await tracker.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'per_2', sessionID, permission: 'bash', patterns: ['second'] },
      },
    });

    expect(waiting).toEqual(['per_1', 'per_2']);
  });
});
