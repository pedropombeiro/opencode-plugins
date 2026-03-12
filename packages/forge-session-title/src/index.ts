import type { Plugin, PluginInput } from '@opencode-ai/plugin';

type Forge = 'github' | 'gitlab';

const DEFAULT_TITLE_RE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T/;
const SKIP_BRANCHES = new Set(['master', 'main', 'HEAD', 'develop']);
const TITLE_PREFIX_RE = /^\[([^\]]*)\] /;

const ISSUE_PATTERNS: RegExp[] = [
  /(?:^|[/])(\d+)[-/]/,
  /[-/](\d+)$/,
  /^(?:issue|gh|bug|fix|feat|feature|hotfix)[-/](\d+)\b/i,
];

const NA_GITHUB = '#N/A';
const NA_GITLAB = '!N/A';

function detectForge(remoteUrl: string): Forge | undefined {
  if (remoteUrl.includes('github.com')) return 'github';
  if (remoteUrl.includes('gitlab')) return 'gitlab';
  return undefined;
}

function naRef(forge: Forge): string {
  return forge === 'github' ? NA_GITHUB : NA_GITLAB;
}

function naRefPattern(forge: Forge): RegExp {
  return forge === 'github' ? /#N\/A/ : /!N\/A/;
}

function realRefPattern(forge: Forge): RegExp {
  return forge === 'github' ? /#\d+/ : /!\d+/;
}

function formatRef(forge: Forge, iid: string): string {
  return forge === 'github' ? `#${iid}` : `!${iid}`;
}

function extractIssueNumber(branch: string): string | undefined {
  for (const pattern of ISSUE_PATTERNS) {
    const match = branch.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

async function getBranch($: PluginInput['$'], worktree: string): Promise<string | undefined> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD 2>/dev/null`.cwd(worktree).text();
    const branch = result.trim();
    if (!branch || branch === 'HEAD') return undefined;
    return branch;
  } catch {
    return undefined;
  }
}

async function getRemoteUrl($: PluginInput['$'], worktree: string): Promise<string | undefined> {
  try {
    const result = await $`git remote get-url origin 2>/dev/null`.cwd(worktree).text();
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getPrIid(
  $: PluginInput['$'],
  worktree: string,
  forge: Forge,
  branch: string,
): Promise<string | undefined> {
  try {
    if (forge === 'github') {
      const output = await $`gh pr list --head ${branch} --json number --jq .[0].number 2>/dev/null`
        .cwd(worktree)
        .text();
      const num = output.trim();
      return num || undefined;
    }
    const output = await $`glab mr list --source-branch ${branch} 2>/dev/null`.cwd(worktree).text();
    const match = output.match(/^!(\d+)\t/m);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

export const ForgeSessionTitlePlugin: Plugin = async ({ client, $, worktree }) => {
  const refCache = new Map<string, string | undefined>();

  const remoteUrl = await getRemoteUrl($, worktree);
  if (!remoteUrl) return {};

  const forge = detectForge(remoteUrl);
  if (!forge) return {};

  async function getCachedRef(branch: string): Promise<string | undefined> {
    if (refCache.has(branch)) return refCache.get(branch);
    const iid = await getPrIid($, worktree, forge!, branch);
    if (iid) refCache.set(branch, iid);
    return iid;
  }

  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;

      const sessionID = event.properties.sessionID;
      const { data: session } = await client.session.get({
        path: { id: sessionID },
      });
      if (!session) return;
      if (session.parentID) return;
      if (DEFAULT_TITLE_RE.test(session.title)) return;

      const branch = await getBranch($, worktree);
      if (!branch || SKIP_BRANCHES.has(branch)) return;

      const existingPrefix = session.title.match(TITLE_PREFIX_RE);

      if (existingPrefix) {
        const prefixContent = existingPrefix[1];
        const hasRealRef = realRefPattern(forge).test(prefixContent);
        if (hasRealRef) return;

        const hasPlaceholder = naRefPattern(forge).test(prefixContent);
        if (!hasPlaceholder) {
          const iid = await getCachedRef(branch);
          const ref = iid ? formatRef(forge, iid) : naRef(forge);
          const newPrefix = `${prefixContent}, ${ref}`;
          const rest = session.title.slice(existingPrefix[0].length);
          const newTitle = `[${newPrefix}] ${rest}`;
          await client.session.update({
            path: { id: sessionID },
            body: { title: newTitle.slice(0, 100) },
          });
          return;
        }

        const iid = await getCachedRef(branch);
        if (!iid) return;
        const newPrefix = prefixContent.replace(naRefPattern(forge), formatRef(forge, iid));
        const rest = session.title.slice(existingPrefix[0].length);
        const newTitle = `[${newPrefix}] ${rest}`;
        await client.session.update({
          path: { id: sessionID },
          body: { title: newTitle.slice(0, 100) },
        });
        return;
      }

      const issueNumber = extractIssueNumber(branch);
      const iid = await getCachedRef(branch);

      const parts: string[] = [];
      if (issueNumber) parts.push(`#${issueNumber}`);
      else parts.push(branch);
      parts.push(iid ? formatRef(forge, iid) : naRef(forge));

      const newTitle = `[${parts.join(', ')}] ${session.title}`;

      await client.session.update({
        path: { id: sessionID },
        body: { title: newTitle.slice(0, 100) },
      });
    },
  };
};
