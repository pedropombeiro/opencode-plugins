import type { ForgeTraits } from './forge';

// Prefixes that opencode-forge-session-title wrote before it tracked its own
// prefix, such as `[#12, !45] `.
const LEGACY_PREFIX_RE = /^\[[^[\],]+, [!#](?:\d+|N\/A)\] /;
const MAX_TITLE_LENGTH = 100;
// Leaves room in the title for the user's text after a branch prefix.
const MAX_BRANCH_LABEL = 40;

const ISSUE_PATTERNS: RegExp[] = [
  /(?:^|[/])(\d+)[-/]/,
  /[-/](\d+)$/,
  /^(?:issue|gh|bug|fix|feat|feature|hotfix)[-/](\d+)\b/i,
];

// The issue number in a branch name, such as `123` in `feature/123-add-login`.
export function extractIssueNumber(branch: string): string | undefined {
  for (const pattern of ISSUE_PATTERNS) {
    const match = branch.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

// Replaces the prefix this plugin last wrote, or a legacy one, with `prefix`.
// Text the user added, including their own bracketed prefixes, is kept.
// Titles stay within MAX_TITLE_LENGTH by shortening the text after the prefix,
// never the prefix itself, so the stored prefix still matches the title.
export function reconcileTitle(title: string, prefix?: string, previousPrefix?: string): string {
  let rest: string;
  if (previousPrefix && title === previousPrefix) rest = '';
  else if (previousPrefix && title.startsWith(`${previousPrefix} `))
    rest = title.slice(previousPrefix.length + 1);
  else rest = title.replace(LEGACY_PREFIX_RE, '');
  if (!prefix) return rest.slice(0, MAX_TITLE_LENGTH);
  const kept = rest.slice(0, Math.max(0, MAX_TITLE_LENGTH - prefix.length - 1));
  return kept ? `${prefix} ${kept}` : prefix;
}

// The prefix for branch-based naming: the branch's issue, or the branch name
// without one, and its PR/MR, or `!N/A` until one exists.
// A branch name longer than MAX_BRANCH_LABEL is shortened with an ellipsis.
export function branchPrefix(
  forge: ForgeTraits,
  branch: string,
  number: string | undefined,
): string {
  const issue = extractIssueNumber(branch);
  const label = issue ? forge.issueReference(issue) : shorten(branch, MAX_BRANCH_LABEL);
  return `[${label}, ${forge.reference(number ?? 'N/A')}]`;
}

const shorten = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;
