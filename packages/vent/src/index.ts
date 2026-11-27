import type { Plugin } from '@opencode/plugin';
import { exec } from './exec.ts';
import { resolveOptions } from './options.ts';
import { buildResolveVentSkill, RESOLVE_VENT_SKILL_ID } from './skill.ts';
import {
  executeVent,
  formatVentResult,
  VENT_DESCRIPTION,
  VENT_GUIDANCE,
  VENT_TOOL_NAME,
  ventInputSchema,
} from './tool.ts';

export { resolveOptions, sanitizeRemote, selectDestination } from './options.ts';
export { buildResolveVentSkill, RESOLVE_VENT_SKILL_ID } from './skill.ts';
export { executeVent, formatVentResult, parseVentInput } from './tool.ts';

export default {
  id: 'opencode-vent',
  async setup(ctx) {
    const options = resolveOptions(ctx.options);
    if (Object.keys(options.destinations).length === 0) {
      return;
    }

    async function ownsSession(sessionID: string): Promise<boolean> {
      const session = await ctx.session.get({ sessionID });
      return session.location.directory === ctx.location.directory;
    }

    const resolveVentSkill = buildResolveVentSkill(options);
    const skills = await ctx.skill.transform((editor) => {
      if (!editor.get(RESOLVE_VENT_SKILL_ID)) {
        editor.add(resolveVentSkill);
      }
    });

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: VENT_TOOL_NAME,
        options: { codemode: false },
        description: VENT_DESCRIPTION,
        input: ventInputSchema,
        execute: async (input, { sessionID, signal }) => {
          const session = await ctx.session.get({ sessionID });
          const directory = session.location.directory;

          let branch: string | undefined;
          try {
            const vcs = await ctx.vcs.get({ location: session.location });
            const current = vcs.data?.branch?.current;
            branch = current && current !== 'HEAD' ? current : undefined;
          } catch {
            branch = undefined;
          }

          const result = await executeVent(input, options, {
            sessionID,
            directory,
            branch,
            exec,
            signal,
          });
          return { content: formatVentResult(result) };
        },
      });
    });

    const contextHook = await ctx.session.hook('context', async (event) => {
      try {
        if (!(await ownsSession(event.sessionID))) return;
        event.system.push({ type: 'text', text: VENT_GUIDANCE });
      } catch {
        return;
      }
    });

    return async () => {
      await Promise.all([tools.dispose(), skills.dispose(), contextHook.dispose()]);
    };
  },
} satisfies Plugin.Plugin;
