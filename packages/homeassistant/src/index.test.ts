import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HomeAssistantPlugin } from './index.ts';

const originalFetch = globalThis.fetch;
const originalConfigPath = process.env['OPENCODE_HA_CONFIG_PATH'];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfigPath === undefined) delete process.env['OPENCODE_HA_CONFIG_PATH'];
  else process.env['OPENCODE_HA_CONFIG_PATH'] = originalConfigPath;
});

describe('HomeAssistantPlugin', () => {
  test('sends a waiting webhook for a permission request after idle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-homeassistant-'));
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({ webhookUrl: 'https://ha.test/webhook' }));
    process.env['OPENCODE_HA_CONFIG_PATH'] = configPath;

    const webhooks: Array<{ waiting?: { id?: string } }> = [];
    const logs: Array<{ level: string; message: string }> = [];
    globalThis.fetch = (async (_input, init) => {
      webhooks.push(JSON.parse(String(init?.body)) as { waiting?: { id?: string } });
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
});
