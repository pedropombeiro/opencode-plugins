import { afterEach, describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HomeAssistantPlugin } from './index.ts';

const originalFetch = globalThis.fetch;
const originalConfigPath = process.env['OPENCODE_HA_CONFIG_PATH'];

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  if (originalConfigPath === undefined) delete process.env['OPENCODE_HA_CONFIG_PATH'];
  else process.env['OPENCODE_HA_CONFIG_PATH'] = originalConfigPath;
});

interface WebhookBody {
  state: string;
  sessionId?: string;
  waiting?: { id?: string };
}

async function createPlugin() {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-homeassistant-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ webhookUrl: 'https://ha.test/webhook' }));
  process.env['OPENCODE_HA_CONFIG_PATH'] = configPath;

  const webhooks: WebhookBody[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  globalThis.fetch = (async (_input, init) => {
    webhooks.push(JSON.parse(String(init?.body)) as WebhookBody);
    return new Response('ok');
  }) as typeof fetch;

  const client = {
    app: {
      log: async ({ body }: { body: { level: string; message: string } }) => {
        logs.push(body);
        return {};
      },
    },
    postSessionIdPermissionsPermissionId: async () => ({}),
  };
  const plugin = await HomeAssistantPlugin({ client, directory, worktree: directory } as never);
  return { directory, logs, plugin, webhooks };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function advanceMinutes(minutes: number): Promise<void> {
  for (let minute = 0; minute < minutes; minute += 1) {
    jest.advanceTimersByTime(60 * 1000);
    await flushPromises();
  }
}

describe('HomeAssistantPlugin', () => {
  test('sends a waiting webhook for a permission request after idle', async () => {
    const { directory, logs, plugin, webhooks } = await createPlugin();
    const sessionID = 'ses_1';

    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });
    await plugin.event?.({
      event: {
        type: 'permission.asked',
        properties: { id: 'per_1', sessionID, permission: 'bash', patterns: ['first'] },
      },
    } as never);
    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
    });
    await plugin.event?.({
      event: {
        type: 'permission.asked',
        properties: { id: 'per_2', sessionID, permission: 'bash', patterns: ['second'] },
      },
    } as never);

    expect(webhooks.filter((body) => body.waiting).map((body) => body.waiting?.id)).toEqual([
      'per_1',
      'per_2',
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'per_2: reactivated idle session ses_1 from incoming permission request',
      }),
    );

    await plugin.dispose?.();
    rmSync(directory, { recursive: true });
  });

  test('does not sweep a session waiting on a permission prompt', async () => {
    jest.useFakeTimers();
    const { directory, plugin, webhooks } = await createPlugin();
    const sessionID = 'ses_waiting';

    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });
    await plugin.event?.({
      event: {
        type: 'permission.asked',
        properties: { id: 'per_waiting', sessionID, permission: 'bash', patterns: ['command'] },
      },
    } as never);

    await advanceMinutes(11);

    expect(webhooks.filter((body) => body.state === 'idle')).toEqual([]);

    await plugin.dispose?.();
    rmSync(directory, { recursive: true });
  });

  test('sweeps a session with no recent activity', async () => {
    jest.useFakeTimers();
    const { directory, plugin, webhooks } = await createPlugin();
    const sessionID = 'ses_stale';

    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });

    await advanceMinutes(10);

    expect(webhooks).toContainEqual(
      expect.objectContaining({ state: 'idle', sessionId: sessionID }),
    );

    await plugin.dispose?.();
    rmSync(directory, { recursive: true });
  });

  test('measures staleness from the last busy activity', async () => {
    jest.useFakeTimers();
    const { directory, plugin, webhooks } = await createPlugin();
    const sessionID = 'ses_active';

    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });
    await advanceMinutes(5);
    await plugin.event?.({
      event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
    });
    await advanceMinutes(6);

    expect(webhooks.filter((body) => body.state === 'idle')).toEqual([]);

    await plugin.dispose?.();
    rmSync(directory, { recursive: true });
  });
});
