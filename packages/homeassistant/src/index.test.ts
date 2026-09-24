import { afterEach, describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeEvent } from '../../_shared/src/v2.ts';
import { createDebugLog, createHomeAssistant, type Config } from './index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

interface WebhookBody {
  state: string;
  sessionId?: string;
  waiting?: { id?: string };
}

function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return { type, data } as unknown as OpenCodeEvent;
}

const started = (sessionID: string) => event('session.execution.started', { sessionID });

function permissionAsked(sessionID: string, id: string, resources = ['command']) {
  return event('permission.asked', { id, sessionID, action: 'shell', resources });
}

function formCreated(sessionID: string, id: string, type = 'string') {
  return event('form.created', {
    form: {
      id,
      sessionID,
      title: 'Questions',
      fields: [
        {
          key: 'q0',
          type,
          title: 'Tea or coffee?',
          options: [
            { value: 'Tea', label: 'Tea' },
            { value: 'Coffee', label: 'Coffee' },
          ],
        },
      ],
    },
  });
}

function createPlugin(config: Config = {}) {
  const webhooks: WebhookBody[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const permissionReplies: unknown[][] = [];
  const formReplies: unknown[][] = [];
  const entity = { state: '' };

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://ha.test/api/states/')) {
      if (init?.method === 'POST') {
        entity.state = (JSON.parse(String(init.body)) as { state: string }).state;
        return new Response('{}');
      }
      return new Response(JSON.stringify({ state: entity.state, attributes: {} }));
    }
    webhooks.push(JSON.parse(String(init?.body)) as WebhookBody);
    return new Response('ok');
  }) as typeof fetch;

  const plugin = createHomeAssistant({
    directory: '/work/project',
    config: { webhookUrl: 'https://ha.test/webhook', ...config },
    log: (level, message) => {
      logs.push({ level, message });
    },
    replyPermission: async (...args) => {
      permissionReplies.push(args);
    },
    replyForm: async (...args) => {
      formReplies.push(args);
    },
  });
  return { entity, formReplies, logs, permissionReplies, plugin, webhooks };
}

const remote = { haApiUrl: 'https://ha.test/api', haToken: 'token' };

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function advanceMinutes(minutes: number): Promise<void> {
  for (let minute = 0; minute < minutes; minute += 1) {
    jest.advanceTimersByTime(60 * 1000);
    await flushPromises();
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createHomeAssistant', () => {
  test('sends busy and idle webhooks for an execution', async () => {
    const { plugin, webhooks } = createPlugin();

    await plugin.handle(started('ses_1'));
    await plugin.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }));

    expect(webhooks.map((body) => body.state)).toEqual(['busy', 'idle']);
    await plugin.dispose();
  });

  test('sends a waiting webhook for a permission request after idle', async () => {
    const { logs, plugin, webhooks } = createPlugin();
    const sessionID = 'ses_1';

    await plugin.handle(started(sessionID));
    await plugin.handle(permissionAsked(sessionID, 'per_1', ['first']));
    await plugin.handle(event('session.execution.succeeded', { sessionID }));
    await plugin.handle(permissionAsked(sessionID, 'per_2', ['second']));

    expect(webhooks.filter((body) => body.waiting).map((body) => body.waiting?.id)).toEqual([
      'per_1',
      'per_2',
    ]);
    expect(logs).toContainEqual({
      level: 'debug',
      message: 'per_2: reactivated idle session ses_1 from incoming permission request',
    });
    await plugin.dispose();
  });

  test('replies to a permission request answered in Home Assistant', async () => {
    const { entity, permissionReplies, plugin } = createPlugin(remote);

    await plugin.handle(started('ses_1'));
    entity.state = 'per_1:allow';
    await plugin.handle(permissionAsked('ses_1', 'per_1'));
    await waitFor(() => permissionReplies.length > 0);

    expect(permissionReplies).toEqual([['ses_1', 'per_1', 'once']]);
    expect(entity.state).toBe('');
    await plugin.dispose();
  });

  test('relays the chosen option value for a form answered in Home Assistant', async () => {
    const { entity, formReplies, plugin } = createPlugin(remote);

    await plugin.handle(started('ses_1'));
    entity.state = 'question:frm_1:1';
    await plugin.handle(formCreated('ses_1', 'frm_1'));
    await waitFor(() => formReplies.length > 0);

    expect(formReplies).toEqual([['ses_1', 'frm_1', { q0: 'Coffee' }]]);
    await plugin.dispose();
  });

  test('answers a multiselect field with a list', async () => {
    const { entity, formReplies, plugin } = createPlugin(remote);

    entity.state = 'question:frm_2:0';
    await plugin.handle(formCreated('ses_1', 'frm_2', 'multiselect'));
    await waitFor(() => formReplies.length > 0);

    expect(formReplies).toEqual([['ses_1', 'frm_2', { q0: ['Tea'] }]]);
    await plugin.dispose();
  });

  test('does not sweep a session waiting on a permission prompt', async () => {
    jest.useFakeTimers();
    const { plugin, webhooks } = createPlugin();

    await plugin.handle(started('ses_waiting'));
    await plugin.handle(permissionAsked('ses_waiting', 'per_waiting'));

    await advanceMinutes(11);

    expect(webhooks.filter((body) => body.state === 'idle')).toEqual([]);
    await plugin.dispose();
  });

  test('sweeps a session with no recent activity', async () => {
    jest.useFakeTimers();
    const { plugin, webhooks } = createPlugin();

    await plugin.handle(started('ses_stale'));

    await advanceMinutes(10);

    expect(webhooks).toContainEqual(
      expect.objectContaining({ state: 'idle', sessionId: 'ses_stale' }),
    );
    await plugin.dispose();
  });

  test('measures staleness from the last step', async () => {
    jest.useFakeTimers();
    const { plugin, webhooks } = createPlugin();

    await plugin.handle(started('ses_active'));
    await advanceMinutes(5);
    await plugin.handle(event('session.step.started', { sessionID: 'ses_active' }));
    await advanceMinutes(6);

    expect(webhooks.filter((body) => body.state === 'idle')).toEqual([]);
    await plugin.dispose();
  });
});

describe('createDebugLog', () => {
  test('writes nothing unless debug is enabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-homeassistant-'));
    const path = join(directory, 'nested', 'debug.log');

    await createDebugLog({ debugLogPath: path })('info', 'ignored');
    await createDebugLog({ debug: true, debugLogPath: path })('info', 'recorded');

    expect(readFileSync(path, 'utf8')).toMatch(/^\S+ info recorded\n$/);
    rmSync(directory, { recursive: true });
  });
});
