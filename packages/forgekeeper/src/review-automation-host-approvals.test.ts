import { describe, expect, test } from 'bun:test';
import type { AutomationRule } from './options';
import { Ineligible, type AutomationRecord } from './review-automation';
import { hostFixture, hostUrl as url, record } from './review-automation-harness';
import { approvalDigest } from './review-preparation';

describe('approval automation host', () => {
  test('verifies bot approvals, refuses human approvals, and runs approval turns in the owning session', async () => {
    const approvalItem = {
      id: 'approval-1',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      at: 10,
      automationAllowed: true,
    };
    const envRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
      execution: 'environment',
      allowedModels: ['gitlab/allowed'],
    };
    const f = hostFixture({
      checkout: 'other-branch',
      rules: [envRule],
      accounts: { gitlabduo: 'duo-id', alice: 'alice-id' },
      request: {
        draft: true,
        reviewersComplete: true,
        approvers: [
          { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true },
          { id: 'alice-id', username: 'alice' },
        ],
      },
    });
    try {
      // Runs in the owning session even when the checkout is on a different branch and the rule uses environment execution.
      const validation = await f.host.validate(approvalItem, true);
      expect(validation.placement).toBe('session');

      const verified = await f.host.approvals!(approvalItem, ['gitlabduo']);
      expect(verified.approvers).toEqual([
        { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true, reviewer: 'gitlabduo' },
      ]);

      // Human approvals are always rejected with Ineligible, even if listed in reviewers or run manually.
      const humanItem = {
        ...approvalItem,
        id: 'approval-human',
        reviewers: ['alice'],
        approverKind: 'human' as const,
      };
      await expect(f.host.approvals!(humanItem, ['alice'])).rejects.toBeInstanceOf(Ineligible);
      await expect(f.host.approvals!(humanItem, undefined)).rejects.toBeInstanceOf(Ineligible);

      // Approval turns get approval follow-up instructions.
      expect(f.instructions({ ...record, item: approvalItem })).toContain(
        'review approval follow-up',
      );
    } finally {
      f.close();
    }
  });

  test('authorizeStart aborts an approval turn if the reviewer unapproves before the model request', async () => {
    const approvalItem = {
      id: 'approval-1',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      at: 10,
      automationAllowed: true,
    };
    const duoRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
      allowedModels: ['gitlab/allowed'],
    };
    const f = hostFixture({
      rules: [duoRule],
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalItem],
      request: {
        draft: true,
        reviewersComplete: true,
        approvers: [],
      },
    });
    const queued: AutomationRecord = {
      ...record,
      item: approvalItem,
      state: 'running',
      digest: approvalDigest([
        { id: 'duo-id', username: 'GitLabDuo', automated: true, reviewID: 'r1' },
      ]),
    };
    try {
      await expect(f.authorizeStart(queued, 'gitlab/allowed')).rejects.toThrow(
        'The reviewer approval changed after the task was queued',
      );
    } finally {
      f.close();
    }
  });

  test('rejects replacement approval B before preparation and enforces author/reviewer rules on manual Act', async () => {
    const approvalA = {
      id: 'approval-A',
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !1',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      approverID: 'duo-id',
      approvalToken: '2026-11-24T07:00:00Z',
      approvalCycle: 1,
      at: 10,
      automationAllowed: true,
    };
    const duoRule: AutomationRule = {
      on: 'review',
      host: 'gitlab.com',
      projects: ['group/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare',
    };
    // Approval A is replaced by B (different reviewID) before preparation: A matches nothing.
    const replaced = hostFixture({
      rules: [duoRule],
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalA],
      request: {
        draft: true,
        reviewersComplete: true,
        approvalsComplete: true,
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T08:00:00Z',
          },
        ],
      },
    });
    try {
      const verified = await replaced.host.approvals!(approvalA, ['gitlabduo']);
      expect(verified.approvers).toEqual([]);
    } finally {
      replaced.close();
    }

    // Manual Act on another author's MR without that author listed in rules is refused.
    const otherAuthor = hostFixture({
      rules: [duoRule],
      viewer: 'me',
      accounts: { gitlabduo: 'duo-id' },
      items: [approvalA],
      request: {
        authorID: 'someone-else',
        draft: true,
        reviewersComplete: true,
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T07:00:00Z',
          },
        ],
      },
    });
    try {
      await expect(otherAuthor.host.validate(approvalA, false)).rejects.toThrow(
        'approval follow-up is not authorized',
      );
      const manualQueued: AutomationRecord = {
        ...record,
        item: approvalA,
        manual: true,
        state: 'running',
        digest: approvalDigest([
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            automated: true,
            reviewID: '2026-11-24T07:00:00Z',
          },
        ]),
      };
      await expect(otherAuthor.authorizeStart(manualQueued, 'gitlab/allowed')).rejects.toThrow(
        'approval follow-up is not authorized',
      );
    } finally {
      otherAuthor.close();
    }
  });
});
