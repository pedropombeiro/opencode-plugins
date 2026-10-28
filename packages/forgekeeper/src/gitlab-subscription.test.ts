import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import type { GitLabMergeRequest } from './forge';
import { subscribeToNotes, type CableSocket } from './gitlab-subscription';
import { cableSocket } from './cable-socket';
import { SubscriptionRateLimit } from './subscription-retry';
import { flush } from './testing';

const mr = { url: 'https://gitlab.example.com/g/p/-/merge_requests/7' } as GitLabMergeRequest;

function harness() {
  const commands: string[][] = [];
  const sent: string[] = [];
  let closed = false;
  const ws: CableSocket = {
    send: (data) => {
      sent.push(data);
    },
    close: () => {
      closed = true;
    },
    onmessage: null,
    onerror: null,
    onclose: null,
    onresponse: null,
  };
  const run: Exec = async (_file, args) => {
    commands.push(args);
    return {
      code: 0,
      stderr: '',
      stdout: args[0] === 'config' ? 'test-credential\n' : '{"id":42,"project_id":3}',
    };
  };
  return {
    commands,
    sent,
    ws,
    run,
    closed: () => closed,
    message: (message: object) => ws.onmessage?.(JSON.stringify(message)),
  };
}

describe('GitLab notes subscription', () => {
  test('never follows redirects with credentials during a failed-handshake probe', async () => {
    let redirected = 0;
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        redirected++;
        return new Response(null, { status: 401 });
      },
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}` },
        });
      },
    });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 2000);
    try {
      await subscribeToNotes(
        harness().run,
        '/repo',
        mr,
        { connected: () => {}, changed: () => {} },
        abort.signal,
        (_url, credential, origin) =>
          cableSocket(`ws://127.0.0.1:${server.port}`, credential, origin),
      );
      expect(redirected).toBe(0);
    } finally {
      clearTimeout(timeout);
      abort.abort();
      server.stop(true);
      target.stop(true);
    }
  });

  test('retrieves reset headers with one bounded probe after a failed native handshake', async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return new Response(null, { status: 429, headers: { 'Retry-After': '2865' } });
      },
    });
    const before = Date.now();
    try {
      const error = await subscribeToNotes(
        harness().run,
        '/repo',
        mr,
        {
          connected: () => {
            throw new Error('Unexpected connection');
          },
          changed: () => {},
        },
        new AbortController().signal,
        (_url, credential, origin) =>
          cableSocket(`ws://127.0.0.1:${server.port}`, credential, origin),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SubscriptionRateLimit);
      expect((error as SubscriptionRateLimit).retryAt).toBeGreaterThanOrEqual(before + 2_865_000);
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('negotiates Action Cable and sends credentials in headers on a real WebSocket', async () => {
    let authorized = false;
    let origin = '';
    let connected = false;
    const abort = new AbortController();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        authorized = request.headers.get('authorization') === 'Bearer test-credential';
        origin = request.headers.get('origin') ?? '';
        if (
          server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'actioncable-v1-json' } })
        )
          return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: 'welcome' }));
        },
        message(ws, data) {
          const { identifier } = JSON.parse(String(data));
          ws.send(JSON.stringify({ identifier, type: 'confirm_subscription' }));
          ws.send(JSON.stringify({ identifier, message: { event: 'updated' } }));
        },
      },
    });
    const timeout = setTimeout(() => abort.abort(), 2000);
    try {
      await subscribeToNotes(
        harness().run,
        '/repo',
        mr,
        {
          connected: () => {
            connected = true;
          },
          changed: () => abort.abort(),
        },
        abort.signal,
        (_url, credential, requestOrigin) =>
          cableSocket(`ws://127.0.0.1:${server.port}`, credential, requestOrigin),
      );
      expect(authorized).toBe(true);
      expect(origin).toBe('https://gitlab.example.com');
      expect(connected).toBe(true);
    } finally {
      clearTimeout(timeout);
      abort.abort();
      server.stop(true);
    }
  });

  test('authenticates to the MR host, subscribes by database ID, filters events, and cleans up', async () => {
    const app = harness();
    const abort = new AbortController();
    let connected = 0;
    let changed = 0;
    const task = subscribeToNotes(
      app.run,
      '/repo',
      mr,
      {
        connected: () => {
          connected++;
        },
        changed: () => {
          changed++;
        },
      },
      abort.signal,
      (url, credential, origin) => {
        expect(url).toBe('wss://gitlab.example.com/-/cable');
        expect(credential).toBe('test-credential');
        expect(origin).toBe('https://gitlab.example.com');
        return app.ws;
      },
    );
    await flush();
    expect(app.commands).toEqual([
      ['config', 'get', 'token', '--host', 'gitlab.example.com'],
      ['api', 'projects/g%2Fp/merge_requests/7', '--hostname', 'gitlab.example.com'],
    ]);
    app.message({ type: 'welcome' });
    const { identifier } = JSON.parse(app.sent[0]);
    expect(JSON.parse(identifier)).toEqual({
      channel: 'Noteable::NotesChannel',
      project_id: 3,
      noteable_type: 'MergeRequest',
      noteable_id: 42,
    });
    app.message({ identifier, message: { event: 'updated' } });
    expect(changed).toBe(0);
    app.message({ identifier, type: 'confirm_subscription' });
    app.message({ identifier, type: 'confirm_subscription' });
    app.message({ identifier: 'other', message: { event: 'updated' } });
    app.message({ identifier, message: { event: 'updated' } });
    expect(connected).toBe(1);
    expect(changed).toBe(1);
    abort.abort();
    await task;
    expect(app.closed()).toBe(true);
    expect(app.ws.onmessage).toBeNull();
  });

  test('ends rejected subscriptions without claiming connectivity', async () => {
    const app = harness();
    let connected = false;
    const task = subscribeToNotes(
      app.run,
      '/repo',
      mr,
      {
        connected: () => {
          connected = true;
        },
        changed: () => {},
      },
      new AbortController().signal,
      () => app.ws,
    );
    await flush();
    app.message({ type: 'welcome' });
    app.message({ identifier: JSON.parse(app.sent[0]).identifier, type: 'reject_subscription' });
    await task;
    expect(connected).toBe(false);
    expect(app.closed()).toBe(true);
  });

  test('uses a conservative cooldown for a 429 without usable headers', async () => {
    const app = harness();
    const before = Date.now();
    const task = subscribeToNotes(
      app.run,
      '/repo',
      mr,
      {
        connected: () => {},
        changed: () => {},
      },
      new AbortController().signal,
      () => app.ws,
    ).catch((error: unknown) => error);
    await flush();
    app.ws.onresponse?.(429, new Headers({ 'retry-after': 'invalid' }));
    const error = await task;
    expect(error).toBeInstanceOf(SubscriptionRateLimit);
    expect((error as SubscriptionRateLimit).retryAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(app.closed()).toBe(true);
  });

  test('does not retrieve credentials for insecure URLs or connect after cancellation', async () => {
    const app = harness();
    const abort = new AbortController();
    const events = { connected: () => {}, changed: () => {} };
    await subscribeToNotes(
      app.run,
      '/repo',
      { ...mr, url: mr.url.replace('https:', 'http:') },
      events,
      abort.signal,
    );
    expect(app.commands).toHaveLength(0);
    const task = subscribeToNotes(app.run, '/repo', mr, events, abort.signal, () => {
      throw new Error('Unexpected socket');
    });
    abort.abort();
    await task;
    expect(app.commands).toHaveLength(1);
  });
});
