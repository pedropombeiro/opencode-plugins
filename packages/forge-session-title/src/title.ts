export type Forge = 'github' | 'gitlab';

const TITLE_PREFIX_RE = /^\[([^\]]*)\] /;
const MAX_TITLE_LENGTH = 100;

const ISSUE_PATTERNS: RegExp[] = [
  /(?:^|[/])(\d+)[-/]/,
  /[-/](\d+)$/,
  /^(?:issue|gh|bug|fix|feat|feature|hotfix)[-/](\d+)\b/i,
];

export function detectForge(remoteUrl: string): Forge | undefined {
  if (remoteUrl.includes('github.com')) return 'github';
  if (remoteUrl.includes('gitlab')) return 'gitlab';
  return undefined;
}

export function extractIssueNumber(branch: string): string | undefined {
  for (const pattern of ISSUE_PATTERNS) {
    const match = branch.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function naRef(forge: Forge): string {
  return forge === 'github' ? '#N/A' : '!N/A';
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

function finish(title: string, current: string): string | undefined {
  const next = title.slice(0, MAX_TITLE_LENGTH);
  return next === current ? undefined : next;
}

export async function prefixTitle(
  title: string,
  forge: Forge,
  branch: string,
  lookupRef: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const existingPrefix = title.match(TITLE_PREFIX_RE);

  if (existingPrefix) {
    const prefixContent = existingPrefix[1] ?? '';
    if (realRefPattern(forge).test(prefixContent)) return undefined;

    const rest = title.slice(existingPrefix[0].length);
    const iid = await lookupRef();

    if (!naRefPattern(forge).test(prefixContent)) {
      const ref = iid ? formatRef(forge, iid) : naRef(forge);
      return finish(`[${prefixContent}, ${ref}] ${rest}`, title);
    }

    if (!iid) return undefined;
    const prefix = prefixContent.replace(naRefPattern(forge), formatRef(forge, iid));
    return finish(`[${prefix}] ${rest}`, title);
  }

  const issueNumber = extractIssueNumber(branch);
  const iid = await lookupRef();
  const parts = [
    issueNumber ? `#${issueNumber}` : branch,
    iid ? formatRef(forge, iid) : naRef(forge),
  ];
  return finish(`[${parts.join(', ')}] ${title}`, title);
}
