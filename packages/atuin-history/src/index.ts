import type { Plugin } from '@opencode-ai/plugin';

const AUTHOR = 'opencode';

export const AtuinHistoryPlugin: Plugin = async ({ $ }) => {
  const sessionResult = await $`atuin uuid`.quiet();
  const session = sessionResult.text().trim();
  const hostnameResult = await $`hostname -s`.quiet();
  const hostname = `${AUTHOR}@${hostnameResult.text().trim()}`;

  return {
    'shell.env': async (_input, output) => {
      output.env['ATUIN_HISTORY_AUTHOR'] = AUTHOR;
      if (session) output.env['ATUIN_SESSION'] = session;
      output.env['ATUIN_HOST_NAME'] = hostname;
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'bash') return;
      const command = (input.args as { command?: string } | undefined)?.command;
      if (!command) return;

      try {
        const env: Record<string, string> = {
          ATUIN_HISTORY_AUTHOR: AUTHOR,
          ATUIN_HOST_NAME: hostname,
        };
        if (session) env['ATUIN_SESSION'] = session;

        const startResult = await $`atuin history start -- ${command}`.env(env).quiet();
        const id = startResult.text().trim();
        if (!id) return;

        const metadata = (output as { metadata?: { exitCode?: number; duration?: number } })
          .metadata;
        const exit = metadata?.exitCode ?? 0;
        const args = ['--exit', String(exit)];
        if (metadata?.duration) {
          args.push('--duration', String(Math.round(metadata.duration * 1e6)));
        }
        await $`atuin history end ${args} -- ${id}`.env(env).quiet();
      } catch {
        /* best effort */
      }
    },
  };
};
