// What an issue's fields get wrong given the PRs/MRs that work on it, such as
// a status that lags behind them or a missing assignee. The lifecycle watcher
// announces each problem once, until it is fixed.
import type { IssueSnapshot, ReviewRequest } from './forge';

const STATUS_LADDER = ['new', 'ready for development', 'in dev', 'in review', 'complete'];
const REQUIRED_LABELS = [
  { name: 'group', prefixes: ['group::'] },
  { name: 'type', prefixes: ['maintenance::', 'bug::', 'feature::'] },
];
export const ISSUE_LABEL_PREFIXES = REQUIRED_LABELS.flatMap(({ prefixes }) => prefixes);

export interface IssueProblem {
  // Stable per problem, so a problem is announced once until it is fixed.
  id: string;
  text: string;
}

export function issueProblems(
  issue: IssueSnapshot,
  requests: readonly ReviewRequest[],
  issueLabel?: string,
): IssueProblem[] {
  if (!issue.open) return [];
  const problems: IssueProblem[] = [];

  if (issue.forge === 'github') {
    if (requests.length > 0 && requests.every((request) => request.state === 'merged')) {
      problems.push({
        id: 'merged',
        text: `All PRs this session tracks for ${issueLabel ?? 'this issue'} have merged, but the issue is still open`,
      });
    }
    return problems;
  }

  const open = requests.filter((request) => request.state === 'opened');
  if (requests.length > 0 && requests.every((request) => request.state === 'merged')) {
    problems.push({
      id: 'merged',
      text: 'all MRs this session tracks for the issue have merged, but it is still open. Confirm whether the issue is complete before closing it',
    });
  } else if (open.length > 0) {
    const expected = open.some((request) => !request.draft) ? 'In review' : 'In dev';
    const current = issue.status?.toLowerCase();
    const behind =
      current === undefined ||
      (STATUS_LADDER.includes(current) &&
        STATUS_LADDER.indexOf(current) < STATUS_LADDER.indexOf(expected.toLowerCase()));
    if (
      behind &&
      issue.availableStatuses?.some((name) => name.toLowerCase() === expected.toLowerCase())
    ) {
      problems.push({
        id: `status:${expected}`,
        text: `the status is ${issue.status ? `"${issue.status}"` : 'not set'}, expected "${expected}"`,
      });
    }
  }

  if (issue.assignees.length === 0) problems.push({ id: 'unassigned', text: 'no assignee' });
  for (const { name, prefixes } of REQUIRED_LABELS) {
    const available = prefixes.filter((prefix) => issue.availableLabelPrefixes?.includes(prefix));
    if (
      available.length &&
      !issue.labels.some((label) => prefixes.some((prefix) => label.startsWith(prefix)))
    )
      problems.push({ id: `label:${name}`, text: `no ${name} label (${available.join(', ')})` });
  }
  if (!issue.milestone && issue.hasActiveMilestones)
    problems.push({ id: 'milestone', text: 'no milestone' });
  return problems;
}
