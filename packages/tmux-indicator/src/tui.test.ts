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

function createContext() {
  const listeners = new Set<Listener>();
  const context = {
    data: {
      listen: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ui: {
      tabs: { enabled: () => false, focus: () => false },
      router: { navigate: () => {} },
    },
  } as unknown as Plugin.Context;
  const emit = async (type: string, data: Record<string, unknown>) => {
    for (const listener of listeners) listener({ details: { type, data } as OpenCodeEvent });
  };
  return { context, emit };
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
    const emit = (index: number, type: string, data: Record<string, unknown>) =>
      instances[index]!.emit(type, data);
    const busy = (index: number, sessionID: string) =>
      emit(index, 'session.execution.started', { sessionID });
    const wait = (index: number, sessionID: string) =>
      emit(index, 'permission.asked', { sessionID, id: sessionID, action: 'shell', resources: [] });
    const idle = (index: number, sessionID: string) =>
      emit(index, 'session.execution.succeeded', { sessionID });
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

    await busy(0, 'ses_a');
    await wait(0, 'ses_a');
    await busy(0, 'ses_b');
    await wait(0, 'ses_b');
    await busy(1, 'ses_c');
    await wait(1, 'ses_c');
    expect(await flag()).toBe('');
    await Bun.sleep(3200);
    await expectState('1', 2);

    await busy(0, 'ses_unrelated');
    await idle(0, 'ses_unrelated');
    await emit(0, 'permission.replied', { sessionID: 'ses_a', requestID: 'ses_a' });
    await expectState('1', 2);
    await idle(0, 'ses_b');
    await expectState('1', 1);
    await idle(1, 'ses_c');
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
