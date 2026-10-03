import type { Plugin } from '@opencode/plugin';
import { exec } from '../../_shared/src/index.ts';
import { sourceBranch } from './source.ts';
import {
  branchPrefix,
  detectForge,
  extractIssueNumber,
  reconcileTitle,
  type Forge,
} from './title.ts';
import { parseTarget, targetPrefix, targetRequest, type Target } from './target.ts';
import { ForgeSessionTitleRpc, type TargetOutput } from './rpc.ts';

const SKIP_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);
type SessionState = { target?: Target; prefix?: string };

function targetOutput(target: Target | undefined): TargetOutput {
  if (!target) return {};
  return { url: target.url, ...(target.issueUrl ? { issueUrl: target.issueUrl } : {}) };
}

async function getForge(directory: string): Promise<Forge | undefined> {
  const result = await exec('git', ['remote', 'get-url', 'origin'], { cwd: directory });
  const url = result.stdout.trim();
  return result.code === 0 && url ? detectForge(url) : undefined;
}

async function getRefIid(
  directory: string,
  forge: Forge,
  branch: string,
): Promise<string | undefined> {
  if (forge === 'github') {
    const result = await exec(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'],
      { cwd: directory },
    );
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }
  const result = await exec('glab', ['mr', 'list', '--source-branch', branch], { cwd: directory });
  if (result.code !== 0) return undefined;
  return result.stdout.match(/^!(\d+)\t/m)?.[1];
}

export default {
  id: 'opencode-forge-session-title',
  async setup(ctx) {
    const forges = new Map<string, Promise<Forge | undefined>>();
    const refs = new Map<string, string>();
    const pending = new Map<string, Promise<void>>();
    const controller = new AbortController();

    async function stateFor(sessionID: string): Promise<SessionState> {
      return ((await ctx.storage.get(`sessions/${sessionID}`)) as SessionState | undefined) ?? {};
    }

    const rpc = await ctx.rpc.register(ForgeSessionTitleRpc, {
      target: async (input) => {
        const { sessionID } = input as { sessionID: string };
        return targetOutput((await stateFor(sessionID)).target);
      },
    });

    function forgeFor(directory: string): Promise<Forge | undefined> {
      let forge = forges.get(directory);
      if (!forge) {
        forge = getForge(directory);
        forges.set(directory, forge);
      }
      return forge;
    }

    async function lookupRef(directory: string, forge: Forge, branch: string) {
      const key = `${directory}\0${branch}`;
      const cached = refs.get(key);
      if (cached) return cached;
      const iid = await getRefIid(directory, forge, branch);
      if (iid) refs.set(key, iid);
      return iid;
    }

    async function update(sessionID: string): Promise<void> {
      const session = await ctx.session.get({ sessionID });
      if (session.parentID || !session.title) return;

      const directory = session.location.directory;
      if (directory !== ctx.location.directory) return;

      const state = await stateFor(sessionID);
      let prefix = state.target ? targetPrefix(state.target) : undefined;
      if (!state.target) {
        const forge = await forgeFor(directory);
        if (forge) {
          const vcs = await ctx.vcs.get({ location: session.location });
          const branch = vcs.data.branch.current;
          if (branch && !SKIP_BRANCHES.has(branch) && branch !== vcs.data.branch.default) {
            prefix = await branchPrefix(forge, branch, () => lookupRef(directory, forge, branch));
          }
        }
      }

      const title = reconcileTitle(session.title, prefix, state.prefix);
      if (title !== session.title) await ctx.session.update({ sessionID, title });
      await ctx.storage.set(`sessions/${sessionID}`, {
        ...(state.target ? { target: state.target } : {}),
        ...(prefix ? { prefix } : {}),
      });
    }

    function schedule(sessionID: string, action = () => update(sessionID)): Promise<void> {
      const previous = pending.get(sessionID) ?? Promise.resolve();
      const next = previous.then(action);
      const settled = next.catch(() => {});
      pending.set(sessionID, settled);
      void settled.then(() => {
        if (pending.get(sessionID) === settled) pending.delete(sessionID);
      });
      return next;
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'set_session_target',
        description:
          'Set the primary issue, PR, or MR for this session title. Use a full URL, or "branch" to return to branch-based naming. Call it after creating a PR/MR for the current task. Without issue_url, the related issue is inferred from the PR/MR source branch name. This only changes local session metadata.',
        input: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'Full GitHub/GitLab issue, PR, or MR URL, or "branch".',
            },
            issue_url: {
              type: 'string',
              description: 'Optional full URL of an established related issue. Omit when unknown.',
            },
          },
          required: ['target'],
          additionalProperties: false,
        },
        execute: async (input, { sessionID }) => {
          const target = parseTarget(input);
          await schedule(sessionID, async () => {
            const session = await ctx.session.get({ sessionID });
            if (session.parentID || session.location.directory !== ctx.location.directory) {
              throw new Error('Session targets can only be set in the current root session.');
            }
            const request = target && !target.issueUrl ? targetRequest(target) : undefined;
            const branch = request
              ? await sourceBranch(request, ctx.location.directory).catch(() => undefined)
              : undefined;
            const branchIssue = branch ? extractIssueNumber(branch) : undefined;
            if (target && branchIssue) target.branchIssue = branchIssue;
            const state = await stateFor(sessionID);
            await ctx.storage.set(`sessions/${sessionID}`, {
              ...(state.prefix ? { prefix: state.prefix } : {}),
              ...(target ? { target } : {}),
            });
            await rpc.events.emit('targetChanged', { sessionID, ...targetOutput(target) });
            await update(sessionID);
          });
          return {
            content: target
              ? `Session target: ${target.url}`
              : 'Session target: checked-out branch.',
          };
        },
      });
    });

    await ctx.session.hook('context', async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || session.location.directory !== ctx.location.directory) return;
      const state = await stateFor(event.sessionID);
      event.system.push({
        type: 'text',
        text: [
          'When the user establishes or changes the primary issue, PR, or MR for this session, call set_session_target with its full URL before starting that work.',
          'After you create a PR or MR for the current task (for example with gpsup, glab mr create, gh pr create, or a forge tool), call set_session_target with the new PR/MR URL. Pass the current issue as issue_url when the PR/MR was created for it.',
          'Background references, comparisons, and dependencies do not change the target. Follow-ups without a new primary target keep the current target.',
          'Include issue_url only when its relationship to the target PR/MR is established. Never carry over the checked-out branch’s issue to another target.',
          'When the user explicitly returns to work on the checked-out branch, call set_session_target with target "branch".',
          `Current session target: ${state.target ? JSON.stringify(state.target) : 'checked-out branch (automatic)'}.`,
        ].join('\n'),
      });
    });

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === 'session.renamed' || event.type === 'session.execution.succeeded') {
          void schedule(event.data.sessionID).catch(() => {});
        }
      }
    })().catch(() => {});

    return async () => {
      controller.abort();
      await rpc.dispose();
    };
  },
} satisfies Plugin.Plugin;
