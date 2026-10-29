import { describe, expect, test } from 'bun:test';
import { DEFAULT_REVIEW_BOTS, matchesReviewBot, statusOptions } from './options';

const notify = { mode: 'notify' as const, actions: [] };
const retarget = (mode: 'prepare' | 'apply') => ({ mode, actions: ['retarget' as const] });

describe('statusOptions', () => {
  test('watches everything and delivers only to the inbox by default', () => {
    expect(statusOptions(undefined)).toEqual({
      enabled: true,
      pollSeconds: 120,
      watch: { humanReviews: true, automatedReviews: true, reviewBots: true, lifecycle: true },
      reviewBots: DEFAULT_REVIEW_BOTS,
      delivery: { reviews: 'inbox', lifecycle: 'inbox' },
      lifecycleExecution: { parentMerged: notify },
      problems: [],
    });
    expect(DEFAULT_REVIEW_BOTS).toEqual({
      'gitlab.com': ['duo-security-review-gitlab-org', 'ai-appsec-security-mr-reviewer-gitlab-org'],
    });
  });

  test('reads explicit settings, and keeps the defaults of sources it leaves out', () => {
    expect(
      statusOptions({
        status: false,
        pollSeconds: 45,
        watch: { humanReviews: false, lifecycle: false },
        delivery: { reviews: 'summary' },
        hosts: ['gitlab.example.com'],
        githubHosts: [],
      }),
    ).toMatchObject({
      enabled: false,
      pollSeconds: 45,
      watch: { humanReviews: false, automatedReviews: true, reviewBots: true, lifecycle: false },
      delivery: { reviews: 'summary', lifecycle: 'inbox' },
      problems: [],
    });
    expect(statusOptions({ delivery: { lifecycle: 'passive' } }).delivery).toEqual({
      reviews: 'inbox',
      lifecycle: 'passive',
    });
  });

  test('ignores invalid values and says which, where, and what it uses instead', () => {
    for (const [options, problem] of [
      [{ status: 'false' }, 'status must be true or false; using true'],
      [{ pollSeconds: -1 }, 'pollSeconds must be a positive number; using 120'],
      [{ pollSeconds: '45' }, 'pollSeconds must be a positive number; using 120'],
      [{ watch: { lifecycle: 'false' } }, 'watch.lifecycle must be true or false; using true'],
      [{ watch: ['lifecycle'] }, 'watch must be an object; using the defaults'],
      [
        { delivery: { reviews: 'summmary' } },
        'delivery.reviews must be one of "inbox", "passive", "summary"; using "inbox"',
      ],
      [{ delivery: 'summary' }, 'delivery must be an object; using the defaults'],
      [{ hosts: 'gitlab.example.com' }, 'hosts must be a list of host names'],
    ] as const) {
      expect(statusOptions(options).problems).toEqual([expect.stringContaining(problem)]);
    }
    const invalid = statusOptions({ watch: { lifecycle: 'false' }, delivery: { reviews: 'x' } });
    expect(invalid.watch.lifecycle).toBe(true);
    expect(invalid.delivery.reviews).toBe('inbox');
  });

  test('reports unknown options, at every level, without failing the others', () => {
    const options = statusOptions({
      reviewBot: {},
      resumeSession: true,
      watch: { humanReview: false, lifecycle: false },
      delivery: { review: 'summary' },
      lifecycleExecution: { conflict: { mode: 'notify' } },
    });
    expect(options.problems).toEqual([
      "reviewBot isn't a Forgekeeper option; ignoring it",
      "resumeSession isn't a Forgekeeper option; ignoring it",
      "watch.humanReview isn't a Forgekeeper option; ignoring it",
      "delivery.review isn't a Forgekeeper option; ignoring it",
      "lifecycleExecution.conflict isn't a Forgekeeper option; ignoring it",
    ]);
    expect(options.watch.lifecycle).toBe(false);
  });

  test('reads the review bots by host, which replace the defaults, and keeps them for invalid values', () => {
    expect(
      statusOptions({
        reviewBots: { 'GitLab.example.com': ['SAST-bot', 'sast-bot'], 'github.com': [] },
      }).reviewBots,
    ).toEqual({ 'gitlab.example.com': ['sast-bot'], 'github.com': [] });
    expect(statusOptions({ reviewBots: {} }).reviewBots).toEqual({});
    for (const [value, reason] of [
      [['duo-security-review-gitlab-org'], 'must map hosts'],
      ['sast-bot', 'must map hosts'],
      [{ 'gitlab.com': ['duo-security-review-*'] }, 'without wildcards'],
      [{ 'gitlab.com': ['two words'] }, 'without wildcards'],
      [{ 'gitlab.com': 'sast-bot' }, 'must list usernames'],
      [{ 'https://gitlab.com': ['sast-bot'] }, "isn't a host name"],
    ] as const) {
      const options = statusOptions({ reviewBots: value });
      expect(options.reviewBots).toEqual(DEFAULT_REVIEW_BOTS);
      expect(options.problems).toEqual([
        expect.stringMatching(new RegExp(`^reviewBots .*${reason}.*; using the defaults$`)),
      ]);
    }
  });

  test('matches review bots by exact username on their own host, ignoring case', () => {
    const bots = statusOptions({
      reviewBots: { 'gitlab.com': ['duo-security-review-gitlab-org'] },
    }).reviewBots;
    expect(matchesReviewBot(bots, 'gitlab.com', 'Duo-Security-Review-GitLab-Org')).toBe(true);
    // A name that only starts the same, or the same name on another host.
    expect(matchesReviewBot(bots, 'gitlab.com', 'duo-security-review-gitlab-org-evil')).toBe(false);
    expect(matchesReviewBot(bots, 'gitlab.example.com', 'duo-security-review-gitlab-org')).toBe(
      false,
    );
  });

  test('grants execution only as each event policy states', () => {
    for (const mode of ['prepare', 'apply'] as const) {
      const options = statusOptions({
        lifecycleExecution: { parentMerged: { mode, actions: ['retarget', 'retarget'] } },
      });
      expect(options.lifecycleExecution.parentMerged).toEqual(retarget(mode));
      expect(options.problems).toEqual([]);
    }
    expect(
      statusOptions({ lifecycleExecution: { parentMerged: { mode: 'notify' } } }),
    ).toMatchObject({ lifecycleExecution: { parentMerged: notify }, problems: [] });
  });

  test('falls back to notifying for every invalid or unsupported policy, and says why', () => {
    for (const [policy, reason] of [
      [{ mode: 'apply' }, 'mode "apply" needs at least one action'],
      // The actions say what preparing works out, so without one there's nothing to prepare.
      [{ mode: 'prepare', actions: [] }, 'mode "prepare" needs at least one action'],
      [{ mode: 'apply', actions: ['push'] }, 'actions has ["push"], but supports only "retarget"'],
      [{ mode: 'everything' }, 'mode must be one of "notify", "prepare", "apply"'],
      [{ mode: 'apply', actions: 'retarget' }, 'actions must be a list'],
      ['apply', 'must be an object'],
    ] as const) {
      const options = statusOptions({ lifecycleExecution: { parentMerged: policy } });
      expect(options.lifecycleExecution.parentMerged).toEqual(notify);
      expect(options.problems).toEqual([
        expect.stringMatching(
          new RegExp(
            `^lifecycleExecution\\.parentMerged .*${reason.replace(/[[\]"()]/g, '\\$&')}.*; using "notify"$`,
          ),
        ),
      ]);
    }
    // Notifying takes no actions, and an unknown key is reported too.
    const extra = statusOptions({
      lifecycleExecution: { parentMerged: { mode: 'notify', actions: ['retarget'], when: 'now' } },
    });
    expect(extra.lifecycleExecution.parentMerged).toEqual(notify);
    expect(extra.problems).toEqual([
      "lifecycleExecution.parentMerged.when isn't a Forgekeeper option; ignoring it",
      'lifecycleExecution.parentMerged mode "notify" takes no actions; using no actions',
    ]);
    expect(statusOptions({ lifecycleExecution: 'apply' }).problems).toEqual([
      'lifecycleExecution must be an object; using the defaults',
    ]);
  });
});
