import { describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createNavigation } from './navigation.ts';

function call(socketPath: string, path: string, method = 'GET') {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = request({ socketPath, path, method }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('waiting session navigation', () => {
  test('lists live waits and selects only a waiting conversation through the supplied client', async () => {
    const published: unknown[] = [];
    const client = {
      tui: {
        publish: async (input: unknown) => {
          published.push(input);
          return { data: true };
        },
      },
    } as unknown as PluginInput['client'];
    const waiting = new Set(['ses_b', 'ses_a']);
    const bridge = await createNavigation(client, '/project with spaces', waiting);
    try {
      expect(statSync(dirname(bridge.socket)).mode & 0o777).toBe(0o700);
      expect(await call(bridge.socket, '/waiting')).toEqual({
        status: 200,
        body: ['ses_a', 'ses_b'],
      });
      expect(await call(bridge.socket, '/select/ses_b', 'POST')).toEqual({
        status: 200,
        body: true,
      });
      expect(published).toEqual([
        expect.objectContaining({
          body: { type: 'tui.session.select', properties: { sessionID: 'ses_b' } },
          query: { directory: '/project with spaces' },
          throwOnError: true,
        }),
      ]);
      waiting.delete('ses_b');
      expect(await call(bridge.socket, '/select/ses_b', 'POST')).toEqual({
        status: 404,
        body: false,
      });
      expect(await call(bridge.socket, '/select/ses_a')).toEqual({ status: 404, body: false });
      expect(await call(bridge.socket, '/waiting')).toEqual({ status: 200, body: ['ses_a'] });
      expect(published).toHaveLength(1);
    } finally {
      await bridge.close();
    }
    expect(existsSync(bridge.socket)).toBe(false);
  });

  test('reports SDK failures instead of claiming the session was selected', async () => {
    const client = {
      tui: {
        publish: async () => {
          throw new Error('OpenCode unavailable');
        },
      },
    } as unknown as PluginInput['client'];
    const bridge = await createNavigation(client, '/project', new Set(['ses_a']));
    try {
      expect(await call(bridge.socket, '/select/ses_a', 'POST')).toEqual({
        status: 502,
        body: false,
      });
    } finally {
      await bridge.close();
    }
  });
});
