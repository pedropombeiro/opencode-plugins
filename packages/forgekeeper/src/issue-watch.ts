// What an issue's fields get wrong given the PRs/MRs that work on it, such as
// a status that lags behind them or a missing assignee. The lifecycle watcher
// announces each problem once, until it is fixed.
import type { IssueSnapshot, ReviewRequest } from './forge';

// shortcut: the status ladder and label prefixes follow GitLab work item statuses and the
// GitLab Development Health team's labels, make them options when another team needs different ones.
const STATUS_LADDER = ['new', 'ready for development', 'in dev', 'in review', 'complete'];
const REQUIRED_LABELS = [
  { name: 'group', prefixes: ['group::'] },
  { name: 'type', prefixes: ['maintenance::', 'bug::', 'feature::'] },
];

export interface IssueProblem {
  // Stable per problem, so a problem is announced once until it is fixed.
  id: string;
  text: string;
}

export function issueProblems(
  issue: IssueSnapshot,
  requests: readonly ReviewRequest[],
): IssueProblem[] {
  if (!issue.open) return [];
  const problems: IssueProblem[] = [];

  const open = requests.filter((request) => request.state === 'opened');
  if (open.length === 0 && requests.some((request) => request.state === 'merged')) {
    problems.push({
      id: 'merged',
      text: 'every linked MR is merged but the issue is still open. Close it and set the status to "Complete", or keep it open on purpose',
    });
  } else if (open.length > 0) {
    const expected = open.some((request) => !request.draft) ? 'In review' : 'In dev';
    const current = issue.status?.toLowerCase();
    const behind =
      current === undefined ||
      (STATUS_LADDER.includes(current) &&
        STATUS_LADDER.indexOf(current) < STATUS_LADDER.indexOf(expected.toLowerCase()));
    if (behind) {
      problems.push({
        id: `status:${expected}`,
        text: `the status is ${issue.status ? `"${issue.status}"` : 'not set'}, expected "${expected}"`,
      });
    }
  }

  if (issue.assignees.length === 0) problems.push({ id: 'unassigned', text: 'no assignee' });
  for (const { name, prefixes } of REQUIRED_LABELS) {
    if (!issue.labels.some((label) => prefixes.some((prefix) => label.startsWith(prefix))))
      problems.push({ id: `label:${name}`, text: `no ${name} label (${prefixes.join(', ')})` });
  }
  if (!issue.milestone) problems.push({ id: 'milestone', text: 'no milestone' });
  return problems;
}
