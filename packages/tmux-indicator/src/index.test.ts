import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { TmuxIndicatorPlugin } from './index.ts';

test('keeps waiting sessions across unrelated activity, startup grace, and multiple instances', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'oc-test-'));
  const socket = join(folder, 'tmux');
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  const hooks: (Hooks & { dispose?: () => Promise<void> })[] = [];
  try {
    await $`tmux -S ${socket} -f /dev/null new-session -d -s test 'sleep 60'`.quiet();
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = '%0';
    const input = {
      $: $.env({ ...process.env }),
      directory: folder,
      client: { tui: { publish: async () => ({ data: true }) } },
    } as unknown as PluginInput;
    hooks.push(await TmuxIndicatorPlugin(input));
    hooks.push(await TmuxIndicatorPlugin(input));
    const event = (index: number, type: string, properties: Record<string, unknown>) =>
      hooks[index].event!({ event: { type, properties } } as Parameters<
        NonNullable<Hooks['event']>
      >[0]);
    const busy = (index: number, sessionID: string) =>
      event(index, 'session.status', { sessionID, status: { type: 'busy' } });
    const wait = (index: number, sessionID: string) =>
      event(index, 'permission.asked', { sessionID, id: sessionID, permission: 'bash' });
    const idle = (index: number, sessionID: string) =>
      event(index, 'session.status', { sessionID, status: { type: 'idle' } });
    const options = () => $`tmux -S ${socket} show-options -p -t %0`.quiet().text();
    const flag = () => $`tmux -S ${socket} show-option -wqv -t %0 @opencode-waiting`.quiet().text();

    await busy(0, 'ses_a');
    await wait(0, 'ses_a');
    await busy(0, 'ses_b');
    await wait(0, 'ses_b');
    await busy(1, 'ses_c');
    await wait(1, 'ses_c');
    await Bun.sleep(3200);
    expect((await flag()).trim()).toBe('1');
    expect((await options()).match(/@opencode-waiting-target-/g)).toHaveLength(2);

    await busy(0, 'ses_unrelated');
    await idle(0, 'ses_unrelated');
    expect((await flag()).trim()).toBe('1');
    await event(0, 'permission.replied', { sessionID: 'ses_a', requestID: 'ses_a' });
    expect((await flag()).trim()).toBe('1');
    await idle(0, 'ses_b');
    expect((await flag()).trim()).toBe('1');
    expect((await options()).match(/@opencode-waiting-target-/g)).toHaveLength(1);
    await idle(1, 'ses_c');
    expect((await flag()).trim()).toBe('');
    expect(await options()).not.toContain('@opencode-waiting-target-');
  } finally {
    for (const hook of hooks) await hook.dispose?.();
    await $`tmux -S ${socket} kill-server`.nothrow().quiet();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(folder, { recursive: true, force: true });
  }
}, 15000);
