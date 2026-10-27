import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSearch, workerURL } from './run.ts';

const dir = mkdtempSync(join(tmpdir(), 'session-search-run-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function database() {
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  db.run(
    'CREATE TABLE session_v2 (id text, project_id text, parent_id text, directory text, ' +
      'title text, time_created integer, time_updated integer, time_archived integer)',
  );
  db.run(
    'CREATE TABLE session_message (id text, session_id text, type text, time_created integer, ' +
      'data text)',
  );
  db.run("INSERT INTO session_v2 VALUES ('ses_a', 'p1', NULL, '/repo', 'A', 1, 1, NULL)");
  db.run(`INSERT INTO session_message VALUES ('msg_1', 'ses_a', 'user', 1, '{"text":"needle"}')`);
  db.close();
  return path;
}

test('resolves the worker next to the module that is running', () => {
  expect(workerURL('file:///pkg/src/run.ts').href).toBe('file:///pkg/src/worker.ts');
  expect(workerURL('file:///pkg/dist/index.js').href).toBe('file:///pkg/dist/worker.js');
});

test('runs the search in a worker', async () => {
  const result = await runSearch({ query: 'needle', database: database() });
  expect(result.sessions.map((session) => session.id)).toEqual(['ses_a']);
});

test('rejects with the search error', async () => {
  await expect(runSearch({ query: 'x', database: join(dir, 'missing.db') })).rejects.toThrow(
    'Database not found',
  );
});

test('rejects when cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(runSearch({ query: 'x' }, controller.signal)).rejects.toThrow('Search cancelled');
});

function script(name: string, source: string) {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path);
}

test('terminates a running search when cancelled', async () => {
  const url = script('slow.ts', 'self.onmessage = () => { setInterval(() => {}, 1000); };');
  const controller = new AbortController();
  const search = runSearch({ query: 'x' }, controller.signal, url);
  setTimeout(() => controller.abort(), 50);
  await expect(search).rejects.toThrow('Search cancelled');
});

test('rejects when the worker exits without replying', async () => {
  const url = script('exit.ts', 'self.onmessage = () => process.exit(3);');
  await expect(runSearch({ query: 'x' }, undefined, url)).rejects.toThrow('Search worker exited');
});

test('resolves the worker from a module URL with a query string', () => {
  expect(workerURL('file:///pkg/src/index.ts?v=1').href).toBe('file:///pkg/src/worker.ts');
});
