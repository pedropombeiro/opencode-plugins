import { describe, expect, test } from 'bun:test';
import type { GitHubPullRequest, ReviewComment, ReviewRef } from './forge';
import { createReviewClaims } from './review-claim';
import {
  defaultSessions,
  harness,
  ProviderMessage,
  settle,
  StatusForge,
  textOf,
  type Options,
  type Transcript,
} from './server-harness';
import { until } from './testing';

describe('reviewer approval notifications and automation', () => {
  test('notifies the owning session and runs an approval follow-up turn when Duo approves a draft MR', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/45';
    forge.set('group/project', '45', {
      draft: true,
      sourceBranch: 'other-mr-branch',
      duoReviewState: 'REVIEW_STARTED',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const claims = createReviewClaims(':memory:');
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, username) =>
        username.toLowerCase() === 'gitlabduo' ? 'duo-id' : undefined,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary', lifecycle: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['GitLabDuo'],
              action: 'prepare',
              execution: 'environment',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();
      expect((await app.feedback()).items).toEqual([]);

      // Duo finishes re-review and approves.
      forge.set('group/project', '45', {
        draft: true,
        sourceBranch: 'other-mr-branch',
        duoReviewState: 'APPROVED',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await until(() => app.prompts.length === 1);

      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: 'approval',
        title: 'GitLab Duo approved !45',
        reviewers: ['GitLabDuo'],
        approverKind: 'automated',
        automationAllowed: true,
        details: ['The MR is still a draft.'],
      });

      // The follow-up turn runs in the owning session even though the local checkout is on branch `feature`.
      expect(app.prompts[0]).toMatchObject({
        sessionID: 'one',
        metadata: { forgekeeper: 'review-approval' },
      });
      expect(app.prompts[0].text).toContain(`A reviewer approved ${url}.`);
      expect(app.prompts[0].text).toContain('The MR is still a draft.');

      const req = await app.request('one', true);
      expect(req.system.map((part) => part.text).join('\n')).toContain(
        'Forgekeeper authorized a restricted review approval follow-up',
      );
      expect(Object.keys(req.tools).sort()).toEqual([
        'forgekeeper_approval_status',
        'forgekeeper_mark_ready',
      ]);
      expect(await app.toolCall('one', 'bash')).toContain(
        'Only Forgekeeper approval follow-up tools are allowed',
      );
      expect(await app.toolCall('one', 'forgekeeper_mark_ready')).toBeUndefined();
      const marked = await app.callTool('forgekeeper_mark_ready', {}, 'one');
      expect(marked.content).toContain(`Marked ${url} as ready`);
      expect(forge.markedReady).toEqual([
        { forge: 'gitlab', host: 'gitlab.com', project: 'group/project', iid: '45' },
      ]);
      expect((await app.evaluatePermission('one', 'allow')).effect).toBe('deny');
      const statusRead = await app.callTool('forgekeeper_approval_status', {}, 'one');
      expect(JSON.parse(statusRead.content)).toMatchObject({ url, draft: false });

      // When a later push resets Duo's approval, the approval item clears from the inbox.
      forge.set('group/project', '45', {
        draft: true,
        sourceBranch: 'other-mr-branch',
        duoReviewState: 'REVIEW_STARTED',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      expect((await app.feedback()).items).toEqual([]);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('delivers human approvals only as tool-free summaries and never starts a turn with tools', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/46';
    forge.set('group/project', '46', {
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const claims = createReviewClaims(':memory:');
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      viewerID: async () => 'me',
      reviewerID: async (_ref, username) =>
        username.toLowerCase() === 'alice' ? 'alice-id' : undefined,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary', lifecycle: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              // Even if a human reviewer is listed in a rule, human approvals must never run tools.
              reviewers: ['alice'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      // Both a colleague (@alice) and the signed-in viewer approve; viewer self-approval is ignored.
      forge.set('group/project', '46', {
        authorID: 'other-author',
        approvers: [
          { id: 'alice-id', username: 'alice' },
          { id: 'me', username: 'me' },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await until(() => app.passive.length === 1);

      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: 'approval',
        title: '@alice approved !46',
        reviewers: ['alice'],
        approverKind: 'human',
      });
      expect(inbox.items[0].automationAllowed).toBeUndefined();
      // No coding/tool prompt was submitted.
      expect(app.prompts).toHaveLength(0);
      // Summary delivery ran with tools stripped.
      const summaryReq = await app.request('one', true);
      expect(Object.keys(summaryReq.tools)).toEqual([]);
      expect(summaryReq.system.map((part) => part.text).join('\n')).toContain('You have no tools.');
      expect(textOf(summaryReq)).toContain('@alice approved !46');
      // Manual Act on feedback also refuses human approvals.
      await expect(app.actOnFeedback(inbox.items[0].id)).rejects.toThrow(
        'Human reviewer approvals cannot start a turn with tools',
      );
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('notifies for configured reviewBot approvals and ignores unconfigured bots', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/47';
    forge.set('group/project', '47', {
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'inbox' },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '47', {
        approvers: [
          { id: 'sec-id', username: 'duo-security-review-gitlab-org', bot: true },
          { id: 'other-bot', username: 'random-bot', bot: true },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: 'approval',
        title: '@duo-security-review-gitlab-org approved !47',
        reviewers: ['duo-security-review-gitlab-org'],
        approverKind: 'bot',
      });
    } finally {
      await app.cleanup();
    }
  });

  test('delivers pending approvals when monitoring unpauses without error toasts while paused', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/48';
    forge.set('group/project', '48', {
      approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      storage: new Map<string, unknown>([
        [
          `status/approvals/one/${encodeURIComponent(url)}`,
          {
            sessionID: 'one',
            url,
            reference: '!48',
            state: 'opened',
            approvers: ['gitlabduo'],
            cycles: { gitlabduo: 1 },
            pending: [
              {
                id: JSON.stringify(['one', url, 'approval', 'gitlabduo', 1]),
                detectedAt: 100,
                approver: { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true },
                title: 'GitLab Duo approved !48',
              },
            ],
            at: 100,
          },
        ],
      ]),
      pluginOptions: {
        inbox: false,
        delivery: { reviews: 'inbox' },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await settle();
      expect((await app.feedback()).paused).toBe(true);
      expect((await app.feedback()).items).toEqual([]);
      expect(
        app.emitted.filter(
          (entry) =>
            entry.name === 'notice' && (entry.data as { variant?: string }).variant === 'error',
        ),
      ).toEqual([]);

      await app.pauseFeedback(false);
      await settle();
      expect((await app.feedback()).items).toHaveLength(1);
      expect((await app.feedback()).items[0]).toMatchObject({
        kind: 'approval',
        title: 'GitLab Duo approved !48',
      });
    } finally {
      await app.cleanup();
    }
  });

  test('does not announce or summarize a revoked approval on restart or unpause', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/49';
    // Forge reports that Duo's approval was revoked while OpenCode was offline.
    forge.set('group/project', '49', {
      approvers: [],
      reviewersComplete: true,
      approvalsComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const storedItem = {
      id: JSON.stringify(['one', url, 'approval', 'gitlabduo', 1]),
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !49',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      approverID: 'duo-id',
      approvalToken: '2026-11-24T07:00:00Z',
      delivery: 'summary' as const,
      at: 100,
    };
    const app = await harness({
      status: forge,
      storage: new Map<string, unknown>([
        ['sessions/one', { targets: [{ kind: 'merge-request', url }] }],
        [
          `status/approvals/one/${encodeURIComponent(url)}`,
          {
            sessionID: 'one',
            url,
            reference: '!49',
            state: 'opened',
            approvers: ['gitlabduo'],
            tokens: { gitlabduo: '2026-11-24T07:00:00Z' },
            cycles: { gitlabduo: 1 },
            pending: [
              {
                id: JSON.stringify(['one', url, 'approval', 'gitlabduo', 2]),
                cycle: 2,
                detectedAt: 150,
                approver: {
                  id: 'duo-id',
                  username: 'GitLabDuo',
                  bot: true,
                  automated: true,
                  reviewID: '2026-11-24T07:05:00Z',
                },
                title: 'GitLab Duo approved !49',
              },
            ],
            at: 150,
          },
        ],
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [storedItem],
            paused: false,
          },
        ],
      ]),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
      },
    });
    try {
      await settle();
      expect((await app.feedback()).items).toEqual([]);
      expect(app.synthetic).toEqual([]);
      expect(app.prompts).toEqual([]);
      expect(
        app.emitted.filter(
          (entry) =>
            entry.name === 'notice' && (entry.data as { variant?: string }).variant === 'info',
        ),
      ).toEqual([]);
    } finally {
      await app.cleanup();
    }
  });

  test('never duplicates or resurrects an acknowledged approval after a watcher write failure', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/50';
    forge.set('group/project', '50', {
      approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const eventID = JSON.stringify(['one', url, 'approval', 'gitlabduo', 1]);
    const app = await harness({
      status: forge,
      storage: new Map<string, unknown>([
        ['sessions/one', { targets: [{ kind: 'merge-request', url }] }],
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [],
            paused: false,
            delivered: [eventID],
          },
        ],
        [
          `status/approvals/one/${encodeURIComponent(url)}`,
          {
            sessionID: 'one',
            url,
            reference: '!50',
            state: 'opened',
            approvers: ['gitlabduo'],
            cycles: { gitlabduo: 1 },
            pending: [
              {
                id: eventID,
                cycle: 1,
                detectedAt: 100,
                approver: { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true },
                title: 'GitLab Duo approved !50',
              },
            ],
            at: 100,
          },
        ],
      ]),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'inbox' },
      },
    });
    try {
      await settle();
      // Already delivered and acknowledged: never reinserted and no duplicate toast.
      expect((await app.feedback()).items).toEqual([]);
      expect(
        app.emitted.filter(
          (entry) =>
            entry.name === 'notice' &&
            (entry.data as { title?: string }).title === 'GitLab Duo approved !50',
        ),
      ).toEqual([]);
    } finally {
      await app.cleanup();
    }
  });

  test('falls back to a tool-free summary for a plan session and refuses mark_ready if approval is revoked', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/51';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '51', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      // Make session `one` a plan session.
      (app.sessions.get('one') as Record<string, unknown>).agent = 'plan';
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '51', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T09:00:00Z',
          },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();

      // Plan session gets no tool turn; it falls back to the tool-free summary.
      expect(app.prompts).toHaveLength(0);
      expect(app.synthetic).toHaveLength(1);
      const summaryReq = await app.request('one', true);
      expect(Object.keys(summaryReq.tools)).toEqual([]);

      // Switching to a coding agent and retrying runs the restricted approval turn;
      // revoking the approval before calling forgekeeper_mark_ready refuses mutation.
      (app.sessions.get('one') as Record<string, unknown>).agent = 'build';
      const itemID = (await app.feedback()).items[0].id;
      await app.actOnFeedback(itemID, true);
      await settle();
      expect(app.prompts).toHaveLength(1);
      await app.request('one', true);

      // Revoke approval before mark_ready runs.
      forge.set('group/project', '51', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await expect(app.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'no longer current',
      );
      expect(forge.markedReady).toEqual([]);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('GitHub human approval with body produces zero tool turns across both inbox paths', async () => {
    const forge = new StatusForge('github');
    const url = 'https://github.com/team/project/pull/12';
    const claims = createReviewClaims(':memory:');
    forge.requests.set('team/project!12', {
      forge: 'github',
      iid: '12',
      title: 'PR 12',
      url,
      state: 'opened',
      draft: false,
      conflicts: false,
      conflictsKnown: true,
      approved: false,
      awaitingReviewers: ['alice'],
      reviewersComplete: true,
      approvalsComplete: true,
      targetProject: 'team/project',
      targetBranch: 'main',
      sourceProject: 'team/project',
      sourceBranch: 'feature',
      headSha: 'abc',
      authorID: 'me',
      unresolvedThreads: 0,
      threadsComplete: true,
      approvers: [],
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => (name === 'alice' ? 'U_ALICE' : undefined),
      // Simulates GitHub feedback after APPROVED review with "LGTM" is excluded by toReview.
      feedback: async () => ({ complete: true, viewerID: 'me', comments: [] }),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'github.com',
              projects: ['team/project'],
              reviewers: ['alice'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.requests.set('team/project!12', {
        ...(forge.requests.get('team/project!12') as GitHubPullRequest),
        approved: true,
        awaitingReviewers: [],
        approvers: [{ id: 'U_ALICE', username: 'alice', reviewID: 'PRR_1' }],
      });
      await app.refresh('one');
      await settle();

      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: 'approval',
        approverKind: 'human',
        reviewers: ['alice'],
        approverID: 'U_ALICE',
        approvalToken: 'PRR_1',
      });
      expect(app.prompts).toHaveLength(0);
      expect(app.synthetic).toHaveLength(1);
      const summaryReq = await app.request('one', true);
      expect(Object.keys(summaryReq.tools)).toEqual([]);
      await expect(app.actOnFeedback(inbox.items[0].id)).rejects.toThrow(
        'Human reviewer approvals cannot start a turn with tools',
      );
      expect(app.prompts).toHaveLength(0);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('refuses manual Act for a watch-only bot and ignores a rule-listed bot not in reviewBots', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/52';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '52', {
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) =>
        name === 'gitlab-release-tools-bot' ? 'release-bot-id' : undefined,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'inbox' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlab-release-tools-bot'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '52', {
        approvers: [
          { id: 'sec-id', username: 'duo-security-review-gitlab-org', bot: true },
          { id: 'release-bot-id', username: 'gitlab-release-tools-bot', bot: true },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();

      // Watch-only bot (in default reviewBots) notifies; unwatched rule-listed bot does not.
      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({
        kind: 'approval',
        reviewers: ['duo-security-review-gitlab-org'],
        approverKind: 'bot',
        canAct: false,
      });
      expect(inbox.items[0].automationAllowed).toBeUndefined();
      // Manual Act is refused for the watch-only bot.
      await expect(app.actOnFeedback(inbox.items[0].id)).rejects.toThrow(
        'No automation rule authorizes follow-up turns for this reviewer approval',
      );
      expect(app.prompts).toHaveLength(0);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('keeps approval turn restricted when compaction runs before the first model request', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/53';
    const claims = createReviewClaims(':memory:');
    const transcripts = new Map<string, Transcript>();
    let clock = 1000;
    forge.set('group/project', '53', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      transcripts,
      now: () => clock,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      clock = 2000;
      forge.set('group/project', '53', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [
          {
            id: 'duo-id',
            username: 'GitLabDuo',
            bot: true,
            automated: true,
            reviewID: '2026-11-24T10:00:00Z',
          },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      expect(app.prompts).toHaveLength(1);

      // Simulate auto-compaction removing the admitted prompt BEFORE the first context hook.
      clock = 2050;
      transcripts.set('one', [{ type: 'compaction', id: 'cmp-pre', time: { created: 2050 } }]);

      // First model request after pre-start compaction still recognizes and restricts the approval turn.
      clock = 2100;
      const firstReq = await app.request('one', true);
      expect(firstReq.system.map((part) => part.text).join('\n')).toContain(
        'Forgekeeper authorized a restricted review approval follow-up',
      );
      expect(Object.keys(firstReq.tools).sort()).toEqual([
        'forgekeeper_approval_status',
        'forgekeeper_mark_ready',
      ]);
      expect(await app.toolCall('one', 'bash')).toContain(
        'Only Forgekeeper approval follow-up tools are allowed',
      );
      expect((await app.evaluatePermission('one', 'allow')).effect).toBe('deny');

      // Second model step (after startedAt=2100 > compaction=2050) stays restricted too!
      clock = 2200;
      const secondReq = await app.request('one', true);
      expect(Object.keys(secondReq.tools).sort()).toEqual([
        'forgekeeper_approval_status',
        'forgekeeper_mark_ready',
      ]);
      expect(await app.toolCall('one', 'bash')).toContain(
        'Only Forgekeeper approval follow-up tools are allowed',
      );
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('enforces target-specific permission rules for forgekeeper_mark_ready across allow, deny, and ask', async () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/54';
    const make = async (
      permissionDecision: Options['permissionDecision'],
      permissionReply?: 'allow' | 'reject',
    ) => {
      const forge = new StatusForge();
      const claims = createReviewClaims(':memory:');
      forge.set('group/project', '54', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      const app = await harness({
        status: forge,
        reviewClaims: claims,
        reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
        permissionDecision,
        permissionReply,
        pluginOptions: {
          inbox: true,
          delivery: { reviews: 'summary' },
          automation: {
            rules: [
              {
                on: 'review',
                host: 'gitlab.com',
                projects: ['group/project'],
                reviewers: ['gitlabduo'],
                action: 'prepare',
              },
            ],
          },
        },
      });
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();
      forge.set('group/project', '54', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      await app.request('one', true);
      return { app, forge, claims };
    };

    // Denied target -> zero forge writes.
    const seenResources: string[][] = [];
    const denied = await make((input) => {
      seenResources.push([...input.resources]);
      return input.action === 'forgekeeper_mark_ready' && input.resources.includes(url)
        ? 'deny'
        : 'allow';
    });
    try {
      await expect(denied.app.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'Permission denied',
      );
      expect(seenResources).toEqual([[url]]);
      expect(denied.forge.markedReady).toEqual([]);
    } finally {
      await denied.app.cleanup();
      denied.claims.close();
    }

    // Unresolved ask -> zero forge writes.
    const rejectedAsk = await make(() => 'ask', 'reject');
    try {
      await expect(rejectedAsk.app.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'not approved',
      );
      expect(rejectedAsk.forge.markedReady).toEqual([]);
    } finally {
      await rejectedAsk.app.cleanup();
      rejectedAsk.claims.close();
    }

    // Approved ask -> mutates once.
    const approvedAsk = await make(() => 'ask', 'allow');
    try {
      const result = await approvedAsk.app.callTool('forgekeeper_mark_ready', {}, 'one');
      expect(result.content).toContain(`Marked ${url} as ready`);
      expect(approvedAsk.forge.markedReady).toHaveLength(1);
    } finally {
      await approvedAsk.app.cleanup();
      approvedAsk.claims.close();
    }
  });

  test('aborts forgekeeper_mark_ready with zero writes when cancelled or paused mid-verification', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/55';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '55', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    let holdLookup = false;
    let lookupStarted!: () => void;
    let releaseLookup!: () => void;
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => {
        if (name !== 'gitlabduo') return undefined;
        if (holdLookup) {
          lookupStarted();
          await new Promise<void>((resolve) => (releaseLookup = resolve));
        }
        return 'duo-id';
      },
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '55', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      await app.request('one', true);

      // 1) Signal aborted while reviewer lookup is pending -> zero writes.
      holdLookup = true;
      const controller = new AbortController();
      const started1 = new Promise<void>((resolve) => (lookupStarted = resolve));
      const call1 = app.callTool('forgekeeper_mark_ready', {}, 'one', {
        signal: controller.signal,
      });
      await started1;
      controller.abort();
      releaseLookup();
      await expect(call1).rejects.toThrow('cancelled');
      expect(forge.markedReady).toEqual([]);

      // 2) Monitoring paused while reviewer lookup is pending -> zero writes.
      const started2 = new Promise<void>((resolve) => (lookupStarted = resolve));
      const call2 = app.callTool('forgekeeper_mark_ready', {}, 'one');
      await started2;
      await app.pauseFeedback(true);
      releaseLookup();
      await expect(call2).rejects.toThrow('canceled');
      expect(forge.markedReady).toEqual([]);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('enforces tightened model rules after reload and switching to plan mid-turn', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/56';
    const claims = createReviewClaims(':memory:');
    const storage = new Map<string, unknown>();
    const transcripts = new Map<string, Transcript>();
    const sessions = defaultSessions();
    forge.set('group/project', '56', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const first = await harness({
      status: forge,
      reviewClaims: claims,
      storage,
      transcripts,
      sessions,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await first.set({ target: url }, 'one');
      await first.watch(['one'], 'one');
      await settle();
      forge.set('group/project', '56', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await first.refresh('one');
      await settle();
      await first.request('one', true);
    } finally {
      await first.cleanup();
    }

    // Reload with narrowed allowedModels -> continuation and mark_ready both refuse.
    const narrowed = await harness({
      status: forge,
      reviewClaims: claims,
      storage,
      transcripts,
      sessions,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              allowedModels: ['anthropic/claude-only'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await expect(narrowed.request('one', true)).rejects.toThrow('anthropic/claude-only');
      await expect(narrowed.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'anthropic/claude-only',
      );
      expect(forge.markedReady).toEqual([]);

      // Switching session to plan mid-turn also refuses continuation and mark_ready.
      (sessions.get('one') as Record<string, unknown>).agent = 'plan';
      await expect(narrowed.request('one', true)).rejects.toThrow('coding agent');
      await expect(narrowed.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'coding agent',
      );
      expect(forge.markedReady).toEqual([]);
    } finally {
      await narrowed.cleanup();
      claims.close();
    }
  });

  test('rechecks disabled watch settings on restart for pending events, undelivered items, and manual Act', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/57';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '57', {
      draft: true,
      approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const storedItem = {
      id: JSON.stringify(['one', url, 'approval', 'gen-1', 'id:duo-id', 1]),
      kind: 'approval' as const,
      sessionID: 'one',
      url,
      title: 'GitLab Duo approved !57',
      links: [url],
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      approverID: 'duo-id',
      delivery: 'summary' as const,
      at: 100,
      automationAllowed: true,
    };
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      storage: new Map<string, unknown>([
        ['sessions/one', { targets: [{ kind: 'merge-request', url }] }],
        [
          `status/approvals/one/${encodeURIComponent(url)}`,
          {
            sessionID: 'one',
            url,
            reference: '!57',
            state: 'opened',
            generation: 'gen-1',
            approvers: ['id:duo-id'],
            cycles: { 'id:duo-id': 1 },
            pending: [
              {
                id: JSON.stringify(['one', url, 'approval', 'gen-1', 'id:duo-id', 2]),
                cycle: 2,
                detectedAt: 150,
                approver: { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true },
                title: 'GitLab Duo approved !57',
              },
            ],
            at: 150,
          },
        ],
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [storedItem],
            paused: false,
          },
        ],
      ]),
      pluginOptions: {
        inbox: true,
        watch: { automatedReviews: false, humanReviews: true },
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await settle();
      // Neither the pending event nor the undelivered inbox item starts a turn or summary.
      expect(app.prompts).toHaveLength(0);
      expect(app.synthetic).toHaveLength(0);
      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].canAct).toBe(false);
      await expect(app.actOnFeedback(storedItem.id)).rejects.toThrow('no longer watched');
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('manual Summarize revalidates live state for revoked approvals and refreshed ready status', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/58';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '58', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'inbox' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '58', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      await app.request('one', true);

      // Mark draft ready; manual Summarize immediately after must NOT report it as still a draft.
      await app.callTool('forgekeeper_mark_ready', {}, 'one');
      const itemID = (await app.feedback()).items[0].id;
      await app.summarizeFeedback(itemID);
      expect(app.synthetic).toHaveLength(1);
      const summaryReq = await app.request('one', true);
      const summaryText = JSON.stringify(summaryReq.messages);
      expect(summaryText).not.toContain('still a draft');

      // Now revoke on the forge without polling: manual Summarize prunes and refuses.
      forge.set('group/project', '58', {
        draft: false,
        sourceBranch: 'other-branch',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await expect(app.summarizeFeedback(itemID)).rejects.toThrow('no longer current');
      expect((await app.feedback()).items).toEqual([]);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('prunes inbox items and watcher records on confirmed session deletion and preserves them on transient failures', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/59';
    forge.set('group/project', '59', {
      approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const makeStorage = () =>
      new Map<string, unknown>([
        ['sessions/gone', { targets: [{ kind: 'merge-request', url }] }],
        [
          `status/approvals/gone/${encodeURIComponent(url)}`,
          {
            sessionID: 'gone',
            url,
            reference: '!59',
            state: 'opened',
            approvers: ['id:duo-id'],
            cycles: { 'id:duo-id': 1 },
            pending: [],
            at: 100,
          },
        ],
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [
              {
                id: 'gone-approval',
                kind: 'approval',
                sessionID: 'gone',
                url,
                title: 'GitLab Duo approved !59',
                links: [url],
                reviewers: ['GitLabDuo'],
                approverKind: 'automated',
                at: 100,
              },
            ],
            paused: false,
          },
        ],
      ]);

    // Confirmed deletion on startup prunes both inbox item and watcher record.
    const confirmedStorage = makeStorage();
    const confirmed = await harness({
      status: forge,
      storage: confirmedStorage,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await settle();
      expect((await confirmed.feedback()).items).toEqual([]);
      expect(confirmedStorage.has(`status/approvals/gone/${encodeURIComponent(url)}`)).toBe(false);
    } finally {
      await confirmed.cleanup();
    }

    // Transient session lookup failure preserves both inbox item and watcher record.
    const transientStorage = makeStorage();
    const transient = await harness({
      status: forge,
      storage: transientStorage,
      failingSession: true,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await settle();
      expect((await transient.feedback()).items).toHaveLength(1);
      expect(transientStorage.has(`status/approvals/gone/${encodeURIComponent(url)}`)).toBe(true);
    } finally {
      await transient.cleanup();
    }

    // Live session.deleted event prunes inbox items and watcher records for that session.
    const liveStorage = makeStorage();
    const sessions = defaultSessions();
    sessions.set('gone', {
      title: 'Soon deleted',
      location: { directory: '/repo' },
      parentID: undefined,
    });
    const live = await harness({
      status: forge,
      storage: liveStorage,
      sessions,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await settle();
      expect((await live.feedback()).items).toHaveLength(1);
      sessions.delete('gone');
      live.emit({ type: 'session.deleted', data: { sessionID: 'gone' } });
      await settle();
      expect((await live.feedback()).items).toEqual([]);
      expect(liveStorage.has(`status/approvals/gone/${encodeURIComponent(url)}`)).toBe(false);
    } finally {
      await live.cleanup();
    }
  });

  test('exposes forge approval requirements and preserves owner intent in model requests', async () => {
    const { approvalStatusData } = await import('./review-preparation');
    const gitlabSatisfied = approvalStatusData(
      {
        forge: 'gitlab',
        iid: '60',
        title: 'Draft MR',
        url: 'https://gitlab.com/group/project/-/merge_requests/60',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        hasApprovals: false,
        approvalRequirementsSatisfied: true,
        awaitingReviewers: [],
        reviewersComplete: true,
        targetProject: 'group/project',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [{ id: 'duo-id', username: 'GitLabDuo', automated: true }],
    );
    const gitlabUnsatisfied = approvalStatusData(
      {
        forge: 'gitlab',
        iid: '60',
        title: 'Draft MR',
        url: 'https://gitlab.com/group/project/-/merge_requests/60',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        hasApprovals: false,
        approvalRequirementsSatisfied: false,
        awaitingReviewers: [],
        reviewersComplete: true,
        targetProject: 'group/project',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [{ id: 'duo-id', username: 'GitLabDuo', automated: true }],
    );
    const gitlabUnknown = approvalStatusData(
      {
        forge: 'gitlab',
        iid: '60',
        title: 'Draft MR',
        url: 'https://gitlab.com/group/project/-/merge_requests/60',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        hasApprovals: false,
        approvalRequirementsSatisfied: null,
        awaitingReviewers: [],
        reviewersComplete: true,
        targetProject: 'group/project',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [{ id: 'duo-id', username: 'GitLabDuo', automated: true }],
    );
    expect(gitlabSatisfied).toMatchObject({
      approved: false,
      hasHumanApprovals: false,
      approvalRequirementsSatisfied: true,
    });
    expect(gitlabUnsatisfied).toMatchObject({
      approved: false,
      hasHumanApprovals: false,
      approvalRequirementsSatisfied: false,
    });
    expect(gitlabUnknown).toMatchObject({
      approvalRequirementsSatisfied: 'unknown',
    });

    const ghChangesRequested = approvalStatusData(
      {
        forge: 'github',
        iid: '10',
        title: 'Draft PR',
        url: 'https://github.com/o/r/pull/10',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        reviewDecision: 'CHANGES_REQUESTED',
        awaitingReviewers: [],
        reviewersComplete: true,
        targetProject: 'o/r',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [{ id: 'B_COPILOT', username: 'copilot-pull-request-reviewer[bot]', automated: true }],
    );
    const ghNoDecision = approvalStatusData(
      {
        forge: 'github',
        iid: '10',
        title: 'Draft PR',
        url: 'https://github.com/o/r/pull/10',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        awaitingReviewers: [],
        reviewersComplete: true,
        targetProject: 'o/r',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [{ id: 'B_COPILOT', username: 'copilot-pull-request-reviewer[bot]', automated: true }],
    );
    expect(ghChangesRequested).toMatchObject({ reviewDecision: 'CHANGES_REQUESTED' });
    expect(ghNoDecision).toMatchObject({ reviewDecision: 'unknown' });

    // Capture the actual model request for both owner histories ("mark ready" vs "notify me only").
    for (const instruction of [
      'Mark this draft MR ready when Duo approves.',
      'Notify me only when Duo approves; do not mark it ready.',
    ]) {
      const forge = new StatusForge();
      const url = 'https://gitlab.com/group/project/-/merge_requests/61';
      const claims = createReviewClaims(':memory:');
      forge.set('group/project', '61', {
        draft: true,
        sourceBranch: 'other-branch',
        approvalRequirementsSatisfied: true,
        hasApprovals: false,
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      const app = await harness({
        status: forge,
        reviewClaims: claims,
        reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
        pluginOptions: {
          inbox: true,
          delivery: { reviews: 'summary' },
          automation: {
            rules: [
              {
                on: 'review',
                host: 'gitlab.com',
                projects: ['group/project'],
                reviewers: ['gitlabduo'],
                action: 'prepare',
              },
            ],
          },
        },
      });
      try {
        await app.set({ target: url }, 'one');
        await app.watch(['one'], 'one');
        await settle();

        forge.set('group/project', '61', {
          draft: true,
          sourceBranch: 'other-branch',
          approvalRequirementsSatisfied: true,
          hasApprovals: false,
          approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
          reviewersComplete: true,
          unresolvedThreads: 0,
          threadsComplete: true,
        });
        await app.refresh('one');
        await settle();
        expect(app.prompts).toHaveLength(1);

        const req = await app.request('one', true, [
          new ProviderMessage({ role: 'user', content: [{ type: 'text', text: instruction }] }),
          new ProviderMessage({
            role: 'user',
            content: [{ type: 'text', text: app.prompts[0].text }],
          }),
        ]);
        const systemText = req.system.map((part) => part.text).join('\n');
        const messageText = req.messages
          .flatMap((msg) => msg.content.map((part) => ('text' in part ? part.text : '')))
          .join('\n');
        expect(systemText).toContain('every condition the user requested is verified as satisfied');
        expect(messageText).toContain(instruction);
        expect(messageText).toContain('"approvalRequirementsSatisfied":true');
        expect(Object.keys(req.tools).sort()).toEqual([
          'forgekeeper_approval_status',
          'forgekeeper_mark_ready',
        ]);
      } finally {
        await app.cleanup();
        claims.close();
      }
    }
  });

  test('re-verifies live approval and model after permission prompt resolves, refusing stale writes', async () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/62';
    const setupCase = async (
      onPermissionOpen: (ctx: {
        forge: StatusForge;
        app: Awaited<ReturnType<typeof harness>>;
      }) => void,
    ) => {
      const forge = new StatusForge();
      const claims = createReviewClaims(':memory:');
      forge.set('group/project', '62', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      let releasePermission!: () => void;
      let permissionOpened!: () => void;
      const opened = new Promise<void>((resolve) => (permissionOpened = resolve));
      const app = await harness({
        status: forge,
        reviewClaims: claims,
        reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
        permissionDecision: () => 'ask',
        permissionReply: async () => {
          permissionOpened();
          await new Promise<void>((resolve) => (releasePermission = resolve));
          return 'allow' as const;
        },
        pluginOptions: {
          inbox: true,
          delivery: { reviews: 'summary' },
          automation: {
            rules: [
              {
                on: 'review',
                host: 'gitlab.com',
                projects: ['group/project'],
                reviewers: ['gitlabduo'],
                allowedModels: ['gitlab/strong'],
                action: 'prepare',
              },
            ],
          },
        },
      });
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();
      forge.set('group/project', '62', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      await app.request('one', true);
      const pending = app.callTool('forgekeeper_mark_ready', {}, 'one');
      await opened;
      onPermissionOpen({ forge, app });
      releasePermission();
      return { pending, forge, app, claims };
    };

    // 1) Approval revoked while permission dialog is open (without polling inbox) -> zero writes.
    const revoked = await setupCase(({ forge }) => {
      forge.set('group/project', '62', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
    });
    try {
      await expect(revoked.pending).rejects.toThrow('no longer current');
      expect(revoked.forge.markedReady).toEqual([]);
    } finally {
      await revoked.app.cleanup();
      revoked.claims.close();
    }

    // 2) Model switched to disallowed model while permission dialog is open -> zero writes.
    const switchedModel = await setupCase(({ app }) => {
      app.useModel('gitlab/cheap');
    });
    try {
      await expect(switchedModel.pending).rejects.toThrow('gitlab/strong');
      expect(switchedModel.forge.markedReady).toEqual([]);
    } finally {
      await switchedModel.app.cleanup();
      switchedModel.claims.close();
    }
  });

  test('refuses forgekeeper_mark_ready when readiness changed after prompt, returning fresh evidence', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/63';
    const claims = createReviewClaims(':memory:');
    forge.set('group/project', '63', {
      draft: true,
      headSha: 'sha-green',
      sourceBranch: 'other-branch',
      pipeline: { id: 'pipe-1', status: 'SUCCESS', label: 'passed' },
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      forge.set('group/project', '63', {
        draft: true,
        headSha: 'sha-green',
        sourceBranch: 'other-branch',
        pipeline: { id: 'pipe-1', status: 'SUCCESS', label: 'passed' },
        approvers: [
          { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true, reviewID: 'R1' },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      await app.request('one', true);

      // Same approval token R1 stays active, but a new push changes headSha and restarts CI!
      forge.set('group/project', '63', {
        draft: true,
        headSha: 'sha-new-push',
        sourceBranch: 'other-branch',
        pipeline: { id: 'pipe-2', status: 'RUNNING', label: 'running', running: true },
        approvers: [
          { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true, reviewID: 'R1' },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      let refusalMessage = '';
      try {
        await app.callTool('forgekeeper_mark_ready', {}, 'one');
      } catch (error) {
        refusalMessage = error instanceof Error ? error.message : String(error);
      }
      expect(refusalMessage).toContain('Readiness status changed');
      expect(refusalMessage).toContain('"headSha":"sha-new-push"');
      expect(refusalMessage).toContain('"status":"RUNNING"');
      expect(forge.markedReady).toEqual([]);

      // Inspecting fresh status updates the turn's readiness snapshot.
      const statusRes = await app.callTool('forgekeeper_approval_status', {}, 'one');
      expect(JSON.parse(statusRes.content)).toMatchObject({
        headSha: 'sha-new-push',
        reviewersComplete: true,
        approvalsComplete: true,
        pipeline: { id: 'pipe-2', status: 'RUNNING', running: true },
      });

      // Once CI passes and approval_status re-reads it, mark_ready succeeds.
      forge.set('group/project', '63', {
        draft: true,
        headSha: 'sha-new-push',
        sourceBranch: 'other-branch',
        pipeline: { id: 'pipe-2', status: 'SUCCESS', label: 'passed', running: false },
        approvers: [
          { id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true, reviewID: 'R1' },
        ],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.callTool('forgekeeper_approval_status', {}, 'one');
      const ok = await app.callTool('forgekeeper_mark_ready', {}, 'one');
      expect(ok.content).toContain(`Marked ${url} as ready`);
      expect(forge.markedReady).toHaveLength(1);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('refuses forgekeeper_mark_ready on pre-delivery compaction, post-compaction, ended attempt, or mismatched assistant message', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/64';
    const claims = createReviewClaims(':memory:');
    const transcripts = new Map<string, Transcript>();
    let clock = 1000;
    let holdPrompt = true;
    let promptEntered!: () => void;
    let releasePrompt!: () => void;
    const entered = new Promise<void>((resolve) => (promptEntered = resolve));
    forge.set('group/project', '64', {
      draft: true,
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      transcripts,
      now: () => clock,
      onPrompt: async () => {
        if (!holdPrompt) return;
        promptEntered();
        await new Promise<void>((resolve) => (releasePrompt = resolve));
      },
      reviewerID: async (_ref, name) => (name === 'gitlabduo' ? 'duo-id' : undefined),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      clock = 2000;
      forge.set('group/project', '64', {
        draft: true,
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await entered;

      // 1) While prompt submission is still pending, another turn compacts -> NOT bound to approval attempt.
      clock = 2050;
      transcripts.set('one', [{ type: 'compaction', id: 'cmp-other', time: { created: 2050 } }]);
      await expect(app.callTool('forgekeeper_mark_ready', {}, 'one')).rejects.toThrow(
        'could not be verified',
      );
      expect(forge.markedReady).toEqual([]);

      // Release submission and run normal start.
      holdPrompt = false;
      clock = 2100;
      transcripts.set('one', []);
      releasePrompt();
      await settle();
      await app.request('one', true);

      // 2) Missing tool invocation IDs -> refused.
      await expect(
        app.callTool('forgekeeper_mark_ready', {}, 'one', { messageID: undefined, id: undefined }),
      ).rejects.toThrow('Missing tool invocation identity');

      // 3) Call from a different assistant message than the active one -> refused.
      const activeTranscript = transcripts.get('one') ?? [];
      activeTranscript.push({
        type: 'assistant',
        id: 'msg_assistant_live',
        time: { created: 2150 },
      });
      transcripts.set('one', activeTranscript);
      await expect(
        app.callTool('forgekeeper_mark_ready', {}, 'one', {
          messageID: 'msg_assistant_stale',
          id: 'call_stale',
        }),
      ).rejects.toThrow('active assistant response');
      expect(forge.markedReady).toEqual([]);

      // 4) Running record with `ended` already set -> refused.
      const [record] = await claims.records.list();
      await claims.records.save({ ...record, ended: { outcome: 'succeeded', at: 2160 } }, record);
      await expect(
        app.callTool('forgekeeper_mark_ready', {}, 'one', {
          messageID: 'msg_assistant_live',
          id: 'call_live',
        }),
      ).rejects.toThrow('only available during an active');
      expect(forge.markedReady).toEqual([]);

      // 5) Restore non-ended running record, then compact transcript -> mark_ready fails closed.
      const [endedRecord] = await claims.records.list();
      const runningAgain = { ...endedRecord };
      delete runningAgain.ended;
      await claims.records.save(runningAgain, endedRecord);
      clock = 2200;
      transcripts.set('one', [{ type: 'compaction', id: 'cmp-mid', time: { created: 2200 } }]);
      await expect(
        app.callTool('forgekeeper_mark_ready', {}, 'one', {
          messageID: 'msg_assistant_live',
          id: 'call_live',
        }),
      ).rejects.toThrow('could not be verified');
      expect(forge.markedReady).toEqual([]);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('enforces author-scoped rules on approval continuations even when another author has an unrestricted rule', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/65';
    const claims = createReviewClaims(':memory:');
    const storage = new Map<string, unknown>();
    const transcripts = new Map<string, Transcript>();
    const sessions = defaultSessions();
    forge.set('group/project', '65', {
      draft: true,
      authorID: 'author-a',
      sourceBranch: 'other-branch',
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const resolveReviewer = async (_ref: ReviewRef, name: string) => {
      switch (name) {
        case 'gitlabduo':
          return 'duo-id';
        case 'alice':
          return 'author-a';
        case 'bob':
          return 'author-b';
        default:
          return undefined;
      }
    };
    const first = await harness({
      status: forge,
      reviewClaims: claims,
      storage,
      transcripts,
      sessions,
      reviewerID: resolveReviewer,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              authors: ['alice'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              authors: ['bob'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await first.set({ target: url }, 'one');
      await first.watch(['one'], 'one');
      await settle();
      forge.set('group/project', '65', {
        draft: true,
        authorID: 'author-a',
        sourceBranch: 'other-branch',
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await first.refresh('one');
      await settle();
      await first.request('one', true);
    } finally {
      await first.cleanup();
    }

    // Reload: tighten only alice's rule while bob's rule stays unrestricted -> continuation refuses!
    const narrowed = await harness({
      status: forge,
      reviewClaims: claims,
      storage,
      transcripts,
      sessions,
      reviewerID: resolveReviewer,
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              authors: ['alice'],
              reviewers: ['gitlabduo'],
              allowedModels: ['anthropic/strict-only'],
              action: 'prepare',
            },
            {
              on: 'review',
              host: 'gitlab.com',
              projects: ['group/project'],
              authors: ['bob'],
              reviewers: ['gitlabduo'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await expect(narrowed.request('one', true)).rejects.toThrow('anthropic/strict-only');
    } finally {
      await narrowed.cleanup();
      claims.close();
    }
  });

  test('exposes reviewer/approval completeness and actor kind in approval status', async () => {
    const { approvalStatusData } = await import('./review-preparation');
    const partial = approvalStatusData(
      {
        forge: 'gitlab',
        iid: '66',
        title: 'Draft MR',
        url: 'https://gitlab.com/group/project/-/merge_requests/66',
        state: 'opened',
        draft: true,
        conflicts: false,
        conflictsKnown: true,
        approved: false,
        hasApprovals: false,
        approvalRequirementsSatisfied: true,
        awaitingReviewers: [],
        reviewersComplete: false,
        approvalsComplete: false,
        targetProject: 'group/project',
        targetBranch: 'main',
        sourceBranch: 'feat',
        unresolvedThreads: 0,
        threadsComplete: true,
      },
      [
        { id: 'bot-1', username: 'duo-security-review-gitlab-org', bot: true },
        { id: 'human-1', username: 'alice' },
      ],
    );
    expect(partial).toMatchObject({
      awaitingReviewers: 'unknown',
      awaitingReviewersScope: 'humans',
      reviewersComplete: false,
      approvalsComplete: false,
      approved: 'unknown',
      hasHumanApprovals: 'unknown',
    });
    expect(partial.approvers).toEqual([
      { id: 'bot-1', username: 'duo-security-review-gitlab-org', kind: 'bot', bot: true },
      { id: 'human-1', username: 'alice', kind: 'human' },
    ]);
  });

  test('keeps GitHub human APPROVED inline comments strictly informational even when the human is listed in an automation rule', async () => {
    const forge = new StatusForge('github');
    const url = 'https://github.com/owner/repo/pull/70';
    const claims = createReviewClaims(':memory:');
    let clock = 0;
    const basePR = {
      forge: 'github' as const,
      iid: '70',
      title: 'Feature',
      url,
      state: 'opened' as const,
      draft: false,
      conflicts: false,
      conflictsKnown: true,
      approved: false,
      awaitingReviewers: [],
      reviewersComplete: true,
      targetProject: 'owner/repo',
      targetBranch: 'main',
      sourceBranch: 'feature',
      headSha: 'abc',
      authorID: 'me',
      unresolvedThreads: 0,
      threadsComplete: true,
      approvers: [],
    };
    forge.requests.set('owner/repo!70', basePR);
    let comments: ReviewComment[] = [];
    const app = await harness({
      status: forge,
      reviewClaims: claims,
      now: () => clock,
      reviewerID: async (_ref, name) => (name === 'alice' ? 'U_ALICE' : undefined),
      feedback: async () => ({ complete: true, viewerID: 'me', comments }),
      details: async (_target, ids) =>
        comments
          .filter((c) => ids.includes(c.id))
          .map((c) => ({
            id: c.id,
            url: c.url,
            username: c.username,
            authorID: c.authorID,
            ...(c.bot ? { bot: true } : {}),
            ...(c.reviewState ? { reviewState: c.reviewState } : {}),
            body: 'LGTM, tiny nit',
          })),
      pluginOptions: {
        inbox: true,
        delivery: { reviews: 'summary' },
        automation: {
          rules: [
            {
              on: 'review',
              host: 'github.com',
              projects: ['owner/repo'],
              reviewers: ['alice'],
              action: 'prepare',
            },
          ],
        },
      },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      // Alice submits an APPROVED review containing an inline comment.
      clock = 10_000;
      comments = [
        {
          id: 'RC_APPROVAL_NIT',
          order: 10_000,
          url: `${url}#discussion_r1`,
          editedAt: 10_000,
          resolved: false,
          bot: false,
          authorID: 'U_ALICE',
          username: 'alice',
          reviewState: 'APPROVED',
        },
      ];
      await app.refresh('one');
      await settle();
      clock = 10_000 + 5 * 60_000;
      await app.refresh('one');
      await settle();

      const inbox = await app.feedback();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].canAct).toBe(false);
      // Informational summary only; zero coding prompts!
      expect(app.prompts).toHaveLength(0);
      expect(app.synthetic).toHaveLength(1);
      await expect(app.actOnFeedback(inbox.items[0].id)).rejects.toThrow(
        'Human reviewer approvals cannot start a turn with tools',
      );
      expect(app.prompts).toHaveLength(0);
    } finally {
      await app.cleanup();
      claims.close();
    }
  });

  test('reconciles tokenless GitLab revocation observed by manual Summarize so a subsequent reapproval fires', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/71';
    let clock = 1000;
    forge.set('group/project', '71', {
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      now: () => clock,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();

      // 1) Tokenless GitLab Duo approves -> cycle 1 delivered.
      clock = 2000;
      forge.set('group/project', '71', {
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      const firstInbox = await app.feedback();
      expect(firstInbox.items).toHaveLength(1);
      expect(firstInbox.items[0].approvalCycle).toBe(1);

      // 2) Duo revokes; user requests manual Summarize BEFORE next status poll -> prunes & reconciles baseline.
      clock = 3000;
      forge.set('group/project', '71', {
        approvers: [],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await expect(app.summarizeFeedback(firstInbox.items[0].id)).rejects.toThrow(
        'no longer current',
      );
      expect((await app.feedback()).items).toEqual([]);

      // 3) Duo reapproves BEFORE next status poll -> next poll detects cycle 2!
      clock = 4000;
      forge.set('group/project', '71', {
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });
      await app.refresh('one');
      await settle();
      const secondInbox = await app.feedback();
      expect(secondInbox.items).toHaveLength(1);
      expect(secondInbox.items[0].approvalCycle).toBe(2);
    } finally {
      await app.cleanup();
    }
  });

  test('re-adding a removed target within cache TTL baselines from live forge state without replaying unwatched approvals', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/72';
    let clock = 1000;
    forge.set('group/project', '72', {
      approvers: [],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      now: () => clock,
      pluginOptions: { inbox: true, delivery: { reviews: 'inbox' } },
    });
    try {
      await app.set({ target: url }, 'one');
      await app.watch(['one'], 'one');
      await settle();
      expect((await app.feedback()).items).toEqual([]);

      // Remove target while unapproved state is still warm in statusCache.
      clock = 2000;
      await app.set({ target: 'none' }, 'one');
      await settle();

      // Duo approves while target is unwatched!
      forge.set('group/project', '72', {
        approvers: [{ id: 'duo-id', username: 'GitLabDuo', bot: true, automated: true }],
        reviewersComplete: true,
        unresolvedThreads: 0,
        threadsComplete: true,
      });

      // Re-add target immediately within cache TTL -> must invalidate cache and baseline silently!
      clock = 3000;
      await app.set({ target: url }, 'one');
      await settle();
      expect((await app.feedback()).items).toEqual([]);

      // Expire cache and poll again -> still zero events for the approval made while unwatched.
      clock = 100_000;
      await app.refresh('one');
      await settle();
      expect((await app.feedback()).items).toEqual([]);
    } finally {
      await app.cleanup();
    }
  });

  test('skips redundant per-item forge reads on retry passes for inbox-only and already-notified human approvals', async () => {
    const forge = new StatusForge();
    const url = 'https://gitlab.com/group/project/-/merge_requests/73';
    forge.set('group/project', '73', {
      approvers: [{ id: 'alice-id', username: 'alice' }],
      reviewersComplete: true,
      unresolvedThreads: 0,
      threadsComplete: true,
    });
    const app = await harness({
      status: forge,
      storage: new Map<string, unknown>([
        ['sessions/one', { targets: [{ kind: 'merge-request', url }] }],
        [
          `feedback-inbox/${encodeURIComponent('/repo')}`,
          {
            items: [
              {
                id: 'human-inbox-only',
                kind: 'approval',
                sessionID: 'one',
                url,
                title: '@alice approved !73',
                links: [url],
                reviewers: ['alice'],
                approverKind: 'human',
                approverID: 'alice-id',
                at: 100,
              },
              {
                id: 'human-already-notified',
                kind: 'approval',
                sessionID: 'one',
                url,
                title: '@alice approved !73',
                links: [url],
                reviewers: ['alice'],
                approverKind: 'human',
                approverID: 'alice-id',
                delivery: 'summary',
                notifiedAt: 150,
                at: 100,
              },
            ],
            paused: false,
          },
        ],
      ]),
      pluginOptions: { inbox: true, delivery: { reviews: 'summary' } },
    });
    try {
      await settle();
      const lookupsBefore = forge.lookups.length;
      // Pause and unpause triggers `retryPending()` (same path as the 1-minute retry timer).
      await app.pauseFeedback(true);
      await app.pauseFeedback(false);
      await settle();
      expect(forge.lookups.length).toBe(lookupsBefore);
    } finally {
      await app.cleanup();
    }
  });
});
