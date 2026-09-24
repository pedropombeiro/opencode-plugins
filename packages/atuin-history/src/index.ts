import { hostname } from 'node:os';
import type { Plugin } from '@opencode/plugin';
import { exec } from '../../_shared/src/v2.ts';

const AUTHOR = 'opencode';
const SHELL_TOOL = 'shell';

interface ShellInput {
  command?: unknown;
}

interface ShellMetadata {
  exit?: unknown;
}

export default {
  id: 'opencode-atuin-history',
  async setup(ctx) {
    const uuid = await exec('atuin', ['uuid']);
    if (uuid.code !== 0) return;

    const session = uuid.stdout.trim();
    const env: Record<string, string> = {
      ATUIN_HISTORY_AUTHOR: AUTHOR,
      ATUIN_HOST_NAME: `${AUTHOR}@${hostname().split('.')[0]}`,
    };
    if (session) env['ATUIN_SESSION'] = session;

    const started = new Map<string, number>();

    await ctx.shell.hook('create.before', (event) => {
      Object.assign(event.env, env);
    });

    await ctx.tool.hook('execute.before', (event) => {
      if (event.tool === SHELL_TOOL) started.set(event.id, Date.now());
    });

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.tool !== SHELL_TOOL) return;
      const start = started.get(event.id);
      started.delete(event.id);
      if (event.status !== 'completed') return;

      const command = (event.input as ShellInput | undefined)?.command;
      if (typeof command !== 'string' || !command) return;

      const exit = (event.result.metadata as ShellMetadata | undefined)?.exit;
      const history = await exec('atuin', ['history', 'start', '--', command], { env });
      const id = history.stdout.trim();
      if (history.code !== 0 || !id) return;

      const args = ['history', 'end', '--exit', String(typeof exit === 'number' ? exit : 0)];
      if (start !== undefined) args.push('--duration', String((Date.now() - start) * 1e6));
      await exec('atuin', [...args, '--', id], { env });
    });
  },
} satisfies Plugin.Plugin;
