import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from '@opencode/plugin/tui';
import { exec, type OpenCodeEvent } from '../../_shared/src/index.ts';
import plugin from './tui.ts';

type Listener = (input: { details: OpenCodeEvent }) => void;

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 50 && !check(value); attempt += 1) {
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

const listeners = new Set<Listener>();

function broadcast(type: string, data: Record<string, unknown>): void {
  for (const listener of listeners) listener({ details: { type, data } as OpenCodeEvent });
}

function createContext() {
  const tabs = new Set<string>();
  const context = {
    data: {
      listen: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      session: { root: (sessionID: string) => sessionID },
    },
    ui: {
      tabs: {
        enabled: () => true,
        list: () => [...tabs].map((sessionID) => ({ sessionID })),
        focus: () => false,
      },
      router: { current: () => ({ type: 'home' }), navigate: () => {} },
    },
  } as unknown as Plugin.Context;
  return { context, tabs };
}

test('keeps waiting sessions across unrelated activity, startup grace, and multiple instances', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'oc-test-'));
  const socket = join(folder, 'tmux');
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  const cleanups: Array<() => Promise<void> | void> = [];
  const tmux = async (...args: string[]) => (await exec('tmux', ['-S', socket, ...args])).stdout;
  try {
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', 'sleep 60');
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = '%0';

    const instances = [createContext(), createContext()];
    for (const { context } of instances) {
      const cleanup = await plugin.setup(context);
      if (cleanup) cleanups.push(cleanup);
    }
    const busy = (index: number, sessionID: string) => {
      instances[index]!.tabs.add(sessionID);
      broadcast('session.execution.started', { sessionID });
    };
    const wait = (sessionID: string) =>
      broadcast('permission.asked', { sessionID, id: sessionID, action: 'shell', resources: [] });
    const idle = (sessionID: string) => broadcast('session.execution.succeeded', { sessionID });
    const targets = async () =>
      ((await tmux('show-options', '-p', '-t', '%0')).match(/@opencode-waiting-target-/g) ?? [])
        .length;
    const flag = async () =>
      (await tmux('show-option', '-wqv', '-t', '%0', '@opencode-waiting')).trim();
    const expectState = async (expectedFlag: string, expectedTargets: number) => {
      const state = async () => ({ flag: await flag(), targets: await targets() });
      expect(
        await eventually(
          state,
          (value) => value.flag === expectedFlag && value.targets === expectedTargets,
        ),
      ).toEqual({ flag: expectedFlag, targets: expectedTargets });
    };

    busy(0, 'ses_a');
    wait('ses_a');
    busy(0, 'ses_b');
    wait('ses_b');
    busy(1, 'ses_c');
    wait('ses_c');
    expect(await flag()).toBe('');
    await Bun.sleep(3200);
    await expectState('1', 2);

    busy(0, 'ses_unrelated');
    idle('ses_unrelated');
    broadcast('permission.replied', { sessionID: 'ses_a', requestID: 'ses_a' });
    await expectState('1', 2);
    idle('ses_b');
    await expectState('1', 1);
    idle('ses_c');
    await expectState('', 0);

    broadcast('permission.asked', { sessionID: 'ses_elsewhere', id: 'per_x', action: 'shell' });
    await Bun.sleep(200);
    await expectState('', 0);
  } finally {
    for (const cleanup of cleanups) await cleanup();
    await tmux('kill-server');
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(folder, { recursive: true, force: true });
  }
}, 15000);
