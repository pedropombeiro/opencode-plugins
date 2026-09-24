import type { Plugin } from '@opencode/plugin';
import { exec } from '../../_shared/src/v2.ts';
import { detectForge, prefixTitle, type Forge } from './title.ts';

const SKIP_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);

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
  setup(ctx) {
    const forges = new Map<string, Promise<Forge | undefined>>();
    const refs = new Map<string, string>();
    const pending = new Map<string, Promise<void>>();
    const controller = new AbortController();

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

      const forge = await forgeFor(directory);
      if (!forge) return;

      const vcs = await ctx.vcs.get({ location: session.location });
      const branch = vcs.data.branch.current;
      if (!branch || SKIP_BRANCHES.has(branch) || branch === vcs.data.branch.default) return;

      const title = await prefixTitle(session.title, forge, branch, () =>
        lookupRef(directory, forge, branch),
      );
      if (title) await ctx.session.update({ sessionID, title });
    }

    function schedule(sessionID: string): void {
      const previous = pending.get(sessionID) ?? Promise.resolve();
      const next = previous.then(() => update(sessionID)).catch(() => {});
      pending.set(sessionID, next);
      void next.finally(() => {
        if (pending.get(sessionID) === next) pending.delete(sessionID);
      });
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === 'session.renamed' || event.type === 'session.execution.succeeded') {
          schedule(event.data.sessionID);
        }
      }
    })().catch(() => {});

    return () => controller.abort();
  },
} satisfies Plugin.Plugin;
