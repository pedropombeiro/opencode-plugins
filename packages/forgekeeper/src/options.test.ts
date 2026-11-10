import { describe, expect, test } from 'bun:test';
import { DEFAULT_REVIEW_BOTS, matchesReviewBot, statusOptions } from './options';

const notify = { mode: 'notify' as const, actions: [] };
const prepare = { mode: 'prepare' as const, actions: ['retarget' as const] };

describe('statusOptions', () => {
  test('automation is opt-in and validates whole rules without broadening them', () => {
    const rule = {
      on: 'review' as const,
      host: 'GitLab.com',
      projects: ['team/project'],
      reviewers: ['GitLabDuo'],
      action: 'prepare' as const,
    };
    expect(statusOptions({ automation: { rules: [rule] } }).automation.rules).toEqual([
      { ...rule, host: 'gitlab.com', reviewers: ['gitlabduo'] },
    ]);
    for (const invalid of [
      { ...rule, host: '*.gitlab.com' },
      { ...rule, projects: ['team/*'] },
      { ...rule, reviewers: ['duo*'] },
      { ...rule, reviewers: [] },
      { ...rule, action: 'push' },
      { ...rule, unexpected: true },
    ]) {
      const options = statusOptions({ automation: { rules: [invalid] } });
      expect(options.automation.rules).toEqual([]);
      expect(options.problems).toHaveLength(1);
    }
    expect(statusOptions({ reviewBots: { 'gitlab.com': ['GitLabDuo'] } }).automation.rules).toEqual(
      [],
    );
  });

  test('automation rules restrict models inline or through a named group', () => {
    const rule = {
      on: 'review' as const,
      host: 'gitlab.com',
      projects: ['team/project'],
      reviewers: ['gitlabduo'],
      action: 'prepare' as const,
    };
    const modelGroups = { coding: ['gitlab/strong', 'gitlab/strong', 'openrouter/vendor/model'] };
    const read = (rules: unknown[], groups: unknown = modelGroups) =>
      statusOptions({ automation: { modelGroups: groups, rules } });
    const grouped = read([
      { ...rule, allowedModelGroup: 'coding' },
      { ...rule, allowedModels: ['gitlab/other'] },
      rule,
    ]);
    expect(grouped.problems).toEqual([]);
    expect(grouped.automation.rules).toEqual([
      { ...rule, allowedModels: ['gitlab/strong', 'openrouter/vendor/model'] },
      { ...rule, allowedModels: ['gitlab/other'] },
      rule,
    ]);
    for (const [invalid, problem] of [
      [
        { ...rule, allowedModelGroup: 'coding', allowedModels: ['gitlab/strong'] },
        'automation.rules[0] can set allowedModels or allowedModelGroup, not both; using no rule',
      ],
      [
        { ...rule, allowedModelGroup: 'missing' },
        'automation.rules[0] names allowed model group "missing", which automation.modelGroups doesn\'t define; using no rule',
      ],
      [
        { ...rule, allowedModels: [] },
        'automation.rules[0] allowedModels must be a nonempty list of "provider/model" IDs; using no rule',
      ],
      [
        { ...rule, allowedModels: ['strong'] },
        'automation.rules[0] allowedModels must be a nonempty list of "provider/model" IDs; using no rule',
      ],
    ] as const) {
      const options = read([invalid]);
      expect(options.automation.rules).toEqual([]);
      expect(options.problems).toEqual([problem]);
    }
    const broken = read([{ ...rule, allowedModelGroup: 'empty' }], { empty: [] });
    expect(broken.automation.rules).toEqual([]);
    expect(broken.problems).toEqual([
      'automation.modelGroups.empty must be a nonempty list of "provider/model" IDs; using no group',
      'automation.rules[0] names allowed model group "empty", which automation.modelGroups doesn\'t define; using no rule',
    ]);
  });

  test('automation rules name their trigger, and unsupported triggers are ignored', () => {
    const untriggered = {
      host: 'gitlab.com',
      projects: ['team/project'],
      reviewers: ['GitLabDuo'],
      action: 'prepare',
    };
    for (const rule of [untriggered, { ...untriggered, on: 'job-failed' }]) {
      const options = statusOptions({ automation: { rules: [rule] } });
      expect(options.automation.rules).toEqual([]);
      expect(options.problems).toEqual([
        'automation.rules[0] must set "on" to "review", the only supported trigger; using no rule',
      ]);
    }
    expect(statusOptions({ reviewAutomation: { rules: [] } }).problems).toEqual([
      "reviewAutomation isn't a Forgekeeper option; ignoring it",
    ]);
  });
  test('watches everything and delivers only to the inbox by default', () => {
    expect(statusOptions(undefined)).toEqual({
      enabled: true,
      pollSeconds: 120,
      watch: { humanReviews: true, automatedReviews: true, reviewBots: true, lifecycle: true },
      reviewBots: DEFAULT_REVIEW_BOTS,
      delivery: { reviews: 'inbox', lifecycle: 'inbox' },
      lifecycleExecution: { parentMerged: notify },
      automation: { rules: [] },
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

  test('works out only what each event policy states', () => {
    const options = statusOptions({
      lifecycleExecution: { parentMerged: { mode: 'prepare', actions: ['retarget', 'retarget'] } },
    });
    expect(options.lifecycleExecution.parentMerged).toEqual(prepare);
    expect(options.problems).toEqual([]);
    expect(
      statusOptions({ lifecycleExecution: { parentMerged: { mode: 'notify' } } }),
    ).toMatchObject({ lifecycleExecution: { parentMerged: notify }, problems: [] });
  });

  test('falls back to notifying for every invalid or unsupported policy, and says why', () => {
    for (const [policy, reason] of [
      [{ mode: 'prepare', actions: [] }, 'mode "prepare" needs at least one action'],
      [
        { mode: 'prepare', actions: ['push'] },
        'actions has ["push"], but supports only "retarget"',
      ],
      [{ mode: 'everything' }, 'mode must be one of "notify", "prepare"'],
      [{ mode: 'apply', actions: ['retarget'] }, 'mode must be one of "notify", "prepare"'],
      [{ mode: 'prepare', actions: 'retarget' }, 'actions must be a list'],
      ['apply', 'must be an object, such as {"mode": "notify"}'],
    ] as const) {
      const options = statusOptions({ lifecycleExecution: { parentMerged: policy } });
      expect(options.lifecycleExecution.parentMerged).toEqual(notify);
      expect(options.problems).toEqual([
        `lifecycleExecution.parentMerged ${reason}; using "notify"`,
      ]);
    }
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
