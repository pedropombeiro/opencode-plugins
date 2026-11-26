import { approversOf, awaitingText, type GitLabMergeRequest, type Indicator } from '../../forge';

export function approvalCount(request: GitLabMergeRequest): Indicator | undefined {
  const left = request.approvalsLeft ?? 0;
  if (left <= 0 || request.approvalRequirementsSatisfied === true) return undefined;
  const given = approversOf(request).filter((approver) => !approver.bot).length;
  return {
    text: given
      ? `${given} approval${given === 1 ? '' : 's'} · ${left} more needed`
      : `${left} approval${left === 1 ? '' : 's'} needed`,
    compact: given ? `${given} ✓ +${left}` : `+${left}`,
    tone: 'muted',
    optional: true,
  };
}

export function waitingOn(request: GitLabMergeRequest): Indicator | undefined {
  if (request.awaitingReviewers.length)
    return { text: awaitingText(request.awaitingReviewers), tone: 'muted' };
  if (request.draft) return undefined;

  const missingRules = request.missingRules ?? [];
  const needsApproval =
    missingRules.length > 0 ||
    (request.approvalsLeft ?? 0) > 0 ||
    request.mergeStatus === 'NOT_APPROVED';

  if (!request.conflicts && request.pipeline?.status !== 'FAILED') {
    if (request.mergeTrainIndex != null)
      return { text: `merge train #${request.mergeTrainIndex + 1}`, tone: 'muted', optional: true };
    if (
      request.autoMergeEnabled &&
      (request.approvalRequirementsSatisfied === true ||
        (request.mergeStatus === 'MERGEABLE' && !needsApproval))
    )
      return { text: 'auto-merge set', tone: 'success', optional: true };
  }

  if (request.approved || request.approvalRequirementsSatisfied === true) return undefined;
  const rule = missingRules.find((rule) => rule.type === 'CODE_OWNER' || rule.type === 'REGULAR');
  if (rule)
    return {
      text: rule.type === 'CODE_OWNER' ? 'needs a code owner' : 'needs an approver',
      tone: 'warning',
      optional: true,
    };
  if (request.reviewersComplete && needsApproval)
    return { text: 'needs a reviewer', tone: 'muted', optional: true };
  return undefined;
}

export function reviewIndicators(request: GitLabMergeRequest): Indicator[] {
  const count = approvalCount(request);
  const next = waitingOn(request);
  return [
    ...(count ? [count] : []),
    ...(request.approved && !request.awaitingReviewers.length
      ? [{ text: 'approved', tone: 'success' as const }]
      : []),
    ...(next ? [next] : []),
  ];
}
