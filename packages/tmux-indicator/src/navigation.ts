import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';

interface TuiPublisher {
  publish(options: {
    body: { type: 'tui.session.select'; properties: { sessionID: string } };
    query: { directory: string };
    throwOnError: true;
    signal: AbortSignal;
  }): Promise<{ data?: boolean }>;
}

export async function createNavigation(
  client: PluginInput['client'],
  directory: string,
  waiting: Set<string>,
) {
  const folder = mkdtempSync(join(tmpdir(), 'oc-tmux-'));
  const socket = join(folder, 's');
  const tui = client.tui as unknown as TuiPublisher;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/waiting') {
      response.end(JSON.stringify([...waiting].sort()));
      return;
    }
    const sessionID = request.url?.match(/^\/select\/(ses[a-zA-Z0-9_-]+)$/)?.[1];
    if (request.method !== 'POST' || !sessionID || !waiting.has(sessionID)) {
      response.writeHead(404).end('false');
      return;
    }
    try {
      const result = await tui.publish({
        body: { type: 'tui.session.select', properties: { sessionID } },
        query: { directory },
        throwOnError: true,
        signal: AbortSignal.timeout(3000),
      });
      response
        .writeHead(result.data === true ? 200 : 502)
        .end(JSON.stringify(result.data === true));
    } catch {
      response.writeHead(502).end('false');
    }
  });
  const cleanup = () => rmSync(folder, { recursive: true, force: true });
  try {
    server.listen(socket);
    await once(server, 'listening');
  } catch (error) {
    cleanup();
    throw error;
  }
  server.unref();
  process.once('exit', cleanup);
  return {
    socket,
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      process.off('exit', cleanup);
      cleanup();
    },
  };
}
