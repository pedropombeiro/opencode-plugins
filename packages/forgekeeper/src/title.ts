// Prefixes that opencode-forge-session-title wrote before it tracked its own
// prefix, such as `[#12, !45] `.
const LEGACY_PREFIX_RE = /^\[[^[\],]+, [!#](?:\d+|N\/A)\] /;
const MAX_TITLE_LENGTH = 100;

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
export function reconcileTitle(
  title: string,
  prefix?: string,
  previousPrefix?: string | null,
): string {
  let rest: string;
  if (previousPrefix && title === previousPrefix) rest = '';
  else if (previousPrefix && title.startsWith(`${previousPrefix} `))
    rest = title.slice(previousPrefix.length + 1);
  else rest = prefix && previousPrefix === undefined ? title.replace(LEGACY_PREFIX_RE, '') : title;
  if (!prefix) return rest;
  const kept = rest.slice(0, Math.max(0, MAX_TITLE_LENGTH - prefix.length - 1));
  return kept ? `${prefix} ${kept}` : prefix;
}
