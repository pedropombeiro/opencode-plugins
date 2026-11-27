import { describe, expect, test } from 'bun:test';
import type { FeedbackItem } from './feedback-inbox';
import { automationBatch, Ineligible } from './review-automation';
import { fixture, rule, url } from './review-automation-harness';

describe('approval automation', () => {
  const approvalItem = (overrides: Partial<FeedbackItem> = {}): FeedbackItem => ({
    id: 'approval-1',
    kind: 'approval',
    sessionID: 'one',
    url,
    title: 'GitLab Duo approved !1',
    links: [url],
    reviewers: ['GitLabDuo'],
    approverKind: 'automated',
    details: ['The MR is still a draft.'],
    at: 200,
    automationAllowed: true,
    ...overrides,
  });

  const mrRequest = {
    forge: 'gitlab' as const,
    iid: '1',
    title: 'Draft: Fix bug',
    url,
    state: 'opened' as const,
    draft: true,
    conflicts: false,
    conflictsKnown: true,
    approved: false,
    awaitingReviewers: [],
    reviewersComplete: true,
    targetProject: 'team/project',
    targetBranch: 'main',
    unresolvedThreads: 0,
    threadsComplete: true,
    hasApprovals: false,
    approvalRequirementsSatisfied: false,
  };

  test('triggers a follow-up turn for an authorized non-human approval under a review rule', async () => {
    const entry = approvalItem({ details: ['1 unresolved thread remains.'] });
    const submitted: string[] = [];
    const f = fixture({
      inbox: async () => ({ items: [entry], paused: false }),
      approvals: async () => ({
        request: mrRequest,
        approvers: [
          {
            id: 'duo',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewer: 'gitlabduo',
          },
        ],
      }),
      submit: async (_record, text) => {
        submitted.push(text);
      },
    });
    expect(await f.automation.selectAutomatic(entry)).toBe(true);
    await Promise.allSettled(f.automation.tasks());
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain(`A reviewer approved ${url}.`);
    expect(submitted[0]).toContain('The MR is still a draft.');
    expect(submitted[0]).not.toContain('1 unresolved thread remains.');
    expect(f.records.get(automationBatch(entry))?.state).toBe('completed');
  });

  test('never starts a turn with tools for a human reviewer approval', async () => {
    const humanRule = { ...rule, reviewers: ['alice'] };
    const humanItem = approvalItem({
      id: 'approval-human',
      title: '@alice approved !1',
      reviewers: ['alice'],
      approverKind: 'human',
      automationAllowed: true,
    });
    const f = fixture({
      rules: [humanRule],
      inbox: async () => ({ items: [humanItem], paused: false }),
      approvals: async () => {
        throw new Ineligible('Human reviewer approvals cannot start a turn with tools.');
      },
    });
    expect(await f.automation.selectAutomatic(humanItem)).toBe(false);
    expect(f.submits()).toBe(0);
    await expect(f.automation.act(humanItem)).rejects.toThrow(
      'Human reviewer approvals cannot start a turn with tools',
    );
    expect(f.submits()).toBe(0);
  });

  test('skips and redelivers when the approval is revoked or model is disallowed', async () => {
    const entry = approvalItem();
    const revoked = fixture({
      inbox: async () => ({ items: [entry], paused: false }),
      approvals: async () => ({ request: mrRequest, approvers: [] }),
    });
    expect(await revoked.automation.selectAutomatic(entry)).toBe(false);
    expect(revoked.records.get(automationBatch(entry))?.state).toBe('skipped');
    expect(revoked.submits()).toBe(0);

    const restricted = fixture({
      rules: [{ ...rule, allowedModels: ['gitlab/allowed'] }],
      model: async () => 'gitlab/other',
      inbox: async () => ({ items: [entry], paused: false }),
      approvals: async () => ({
        request: mrRequest,
        approvers: [
          { id: 'duo', username: 'GitLabDuo', bot: true, automated: true, reviewer: 'gitlabduo' },
        ],
      }),
    });
    expect(await restricted.automation.selectAutomatic(entry)).toBe(false);
    expect(restricted.records.get(automationBatch(entry))?.state).toBe('skipped');
    expect(restricted.submits()).toBe(0);
  });

  test('refuses manual Act for a watch-only bot and requires exact canonical bot names', async () => {
    const watchOnly = approvalItem({
      id: 'approval-watch-only',
      reviewers: ['duo-security-review-gitlab-org'],
      approverKind: 'bot',
      automationAllowed: false,
    });
    const f = fixture({
      rules: [rule],
      inbox: async () => ({ items: [watchOnly], paused: false }),
    });
    await expect(f.automation.act(watchOnly)).rejects.toThrow(
      'No automation rule authorizes follow-up turns for this reviewer approval',
    );
    expect(f.submits()).toBe(0);

    // Bare `sec` does not match `sec[bot]` so rule selection and account lookup stay exact.
    const botItem = approvalItem({
      id: 'approval-sec-bot',
      url: 'https://github.com/team/project/pull/1',
      reviewers: ['sec[bot]'],
      approverKind: 'bot',
      automationAllowed: true,
    });
    const ghBareRule = {
      ...rule,
      host: 'github.com',
      projects: ['team/project'],
      reviewers: ['sec'],
    };
    const bare = fixture({
      rules: [ghBareRule],
      inbox: async () => ({ items: [botItem], paused: false }),
    });
    expect(await bare.automation.selectAutomatic(botItem)).toBe(false);
    await expect(bare.automation.act(botItem)).rejects.toThrow(
      'No automation rule authorizes follow-up turns for this reviewer approval',
    );
  });
});
