import { describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
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
  test('lists live waits and selects only a waiting conversation', async () => {
    const selected: string[] = [];
    const waiting = new Set(['ses_b', 'ses_a']);
    const bridge = await createNavigation((sessionID) => {
      selected.push(sessionID);
      return true;
    }, waiting);
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
      expect(selected).toEqual(['ses_b']);
      waiting.delete('ses_b');
      expect(await call(bridge.socket, '/select/ses_b', 'POST')).toEqual({
        status: 404,
        body: false,
      });
      expect(await call(bridge.socket, '/select/ses_a')).toEqual({ status: 404, body: false });
      expect(await call(bridge.socket, '/waiting')).toEqual({ status: 200, body: ['ses_a'] });
      expect(selected).toHaveLength(1);
    } finally {
      await bridge.close();
    }
    expect(existsSync(bridge.socket)).toBe(false);
  });

  test('reports selection failures instead of claiming the session was selected', async () => {
    const bridge = await createNavigation(
      () => {
        throw new Error('OpenCode unavailable');
      },
      new Set(['ses_a']),
    );
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
