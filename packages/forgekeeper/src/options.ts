// The PR/MR status options, from the plugin's `opencode.json` entry. The
// server entry point reads them; the CLI only renders what the server sends.
export interface StatusOptions {
  // `status: false` keeps only session targets and titles.
  enabled: boolean;
  pollSeconds: number;
  watch: Watch;
  // Bot accounts whose comments count as review feedback, such as security
  // reviewers: exact usernames, by host.
  reviewBots: ReviewBots;
  delivery: Delivery;
  lifecycleExecution: LifecycleExecution;
  automation: { rules: AutomationRule[] };
  // Option values that were ignored, and why, for a notice at startup.
  problems: string[];
}

// What Forgekeeper watches. Turning a source off stops everything that
// depends on it: without `lifecycle`, nothing notices merges, so nothing
// proposes retargets either.
export interface Watch {
  // People's review comments.
  humanReviews: boolean;
  // Automated code reviews, such as GitLab Duo's and GitHub Copilot's.
  automatedReviews: boolean;
  // Comments from the accounts `reviewBots` lists.
  reviewBots: boolean;
  // Conflicts, failed jobs, and merges of the session's PRs/MRs.
  lifecycle: boolean;
}

// What an update does besides entering the inbox. `passive` queues a session
// message that starts no turn. `summary` starts a turn that summarizes it.
export type FeedbackDelivery = 'inbox' | 'passive' | 'summary';

export interface Delivery {
  reviews: FeedbackDelivery;
  lifecycle: FeedbackDelivery;
}

export type ExecutionMode = 'notify' | 'prepare';
export type ExecutionAction = 'retarget';

export interface EventPolicy {
  mode: ExecutionMode;
  actions: ExecutionAction[];
}

export interface LifecycleExecution {
  parentMerged: EventPolicy;
}

// What starts an automatic coding turn, and what it does. Each rule names its
// trigger in `on`, so other triggers, such as failed jobs, can be added.
export type AutomationRule = ReviewAutomationRule;

// Feedback from the listed reviewers starts a turn that prepares fixes. With
// `allowedModels`, from the rule or its `allowedModelGroup`, only those
// models, as `provider/model`, may act on that feedback.
export interface ReviewAutomationRule {
  on: 'review';
  host: string;
  projects: string[];
  reviewers: string[];
  action: 'prepare';
  allowedModels?: string[];
}

// Review bot usernames by host, both lowercase.
export type ReviewBots = Readonly<Record<string, readonly string[]>>;

// GitLab.com's security review agents for `gitlab-org`. Duo Security Review
// has one account per top-level group, so other groups add theirs. Names are
// exact: anyone can create a bot account whose name only starts the same.
export const DEFAULT_REVIEW_BOTS: ReviewBots = {
  'gitlab.com': ['duo-security-review-gitlab-org', 'ai-appsec-security-mr-reviewer-gitlab-org'],
};

const DEFAULT_POLL_SECONDS = 120;
const DEFAULT_WATCH: Watch = {
  humanReviews: true,
  automatedReviews: true,
  reviewBots: true,
  lifecycle: true,
};
const DEFAULT_DELIVERY: Delivery = { reviews: 'inbox', lifecycle: 'inbox' };
const NOTIFY: EventPolicy = { mode: 'notify', actions: [] };

const HOST = /^[a-z0-9.-]+(:\d+)?$/;
const USERNAME = /^[a-z0-9_.[\]-]+$/;
const MODEL = /^[^/\s]+\/\S+$/;
const GROUP = /^[a-zA-Z0-9_-]+$/;
const RULE_KEYS = [
  'on',
  'host',
  'projects',
  'reviewers',
  'action',
  'allowedModels',
  'allowedModelGroup',
];
const DELIVERIES: readonly FeedbackDelivery[] = ['inbox', 'passive', 'summary'];
const MODES: readonly ExecutionMode[] = ['notify', 'prepare'];
const ACTIONS: Record<keyof LifecycleExecution, readonly ExecutionAction[]> = {
  parentMerged: ['retarget'],
};
// The top-level options. `hosts` and `githubHosts` are read with the forges.
const OPTIONS = [
  'status',
  'pollSeconds',
  'watch',
  'reviewBots',
  'delivery',
  'lifecycleExecution',
  'automation',
  'hosts',
  'githubHosts',
];

type Source = Record<string, unknown>;

const isObject = (value: unknown): value is Source =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactList = (list: unknown, pattern: RegExp): list is string[] =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.every((entry) => typeof entry === 'string' && pattern.test(entry));
const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ');

// Reads options, collecting each ignored value as a problem that names its
// path and what's used instead.
class Reader {
  readonly problems: string[] = [];

  // Named lists of allowed models that rules share. An invalid group is
  // dropped, so the rules that name it are too.
  modelGroups(value: unknown): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    if (value === undefined) return groups;
    if (!isObject(value)) {
      this.ignore('automation.modelGroups', 'must map group names to model lists', 'no groups');
      return groups;
    }
    for (const [name, models] of Object.entries(value)) {
      if (!GROUP.test(name) || !exactList(models, MODEL)) {
        this.ignore(
          `automation.modelGroups.${name}`,
          'must be a nonempty list of "provider/model" IDs',
          'no group',
        );
        continue;
      }
      groups.set(name, [...new Set(models)]);
    }
    return groups;
  }

  // A rule's allowed models: its own list or its group's, or undefined for
  // any model. Returns null when they're invalid, which drops the rule.
  allowedModels(
    path: string,
    rule: Source,
    groups: ReadonlyMap<string, string[]>,
  ): string[] | undefined | null {
    const { allowedModels: listed, allowedModelGroup: group } = rule;
    if (listed !== undefined && group !== undefined) {
      this.ignore(path, 'can set allowedModels or allowedModelGroup, not both', 'no rule');
      return null;
    }
    if (group !== undefined) {
      const models = typeof group === 'string' ? groups.get(group) : undefined;
      if (models) return models;
      this.ignore(
        path,
        `names allowed model group ${JSON.stringify(group)}, which automation.modelGroups doesn't define`,
        'no rule',
      );
      return null;
    }
    if (listed === undefined) return undefined;
    if (exactList(listed, MODEL)) return [...new Set(listed)];
    this.ignore(path, 'allowedModels must be a nonempty list of "provider/model" IDs', 'no rule');
    return null;
  }

  automation(value: unknown): { rules: AutomationRule[] } {
    const source = this.object('automation', value, ['rules', 'modelGroups']);
    const groups = this.modelGroups(source.modelGroups);
    if (source.rules === undefined) return { rules: [] };
    if (!Array.isArray(source.rules)) {
      this.ignore('automation.rules', 'must be a list', 'no rules');
      return { rules: [] };
    }
    const rules: AutomationRule[] = [];
    source.rules.forEach((rule: unknown, index: number) => {
      const path = `automation.rules[${index}]`;
      if (!isObject(rule) || rule.on !== 'review') {
        this.ignore(path, 'must set "on" to "review", the only supported trigger', 'no rule');
        return;
      }
      if (
        Object.keys(rule).some((key) => !RULE_KEYS.includes(key)) ||
        typeof rule.host !== 'string' ||
        !HOST.test(rule.host.toLowerCase()) ||
        !exactList(rule.projects, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/) ||
        !exactList(rule.reviewers, /^[a-zA-Z0-9_.[\]-]+$/) ||
        rule.action !== 'prepare'
      ) {
        this.ignore(
          path,
          'needs an exact host, project and reviewer lists, and action "prepare"',
          'no rule',
        );
        return;
      }
      const allowedModels = this.allowedModels(path, rule, groups);
      if (allowedModels === null) return;
      rules.push({
        on: 'review',
        host: rule.host.toLowerCase(),
        projects: [...new Set(rule.projects)],
        reviewers: [...new Set(rule.reviewers.map((name) => name.toLowerCase()))],
        action: 'prepare',
        ...(allowedModels ? { allowedModels } : {}),
      });
    });
    return { rules };
  }

  ignore(path: string, reason: string, fallback: string) {
    this.problems.push(`${path} ${reason}; using ${fallback}`);
  }

  // Reports the keys of `source` that aren't `known`.
  unknown(path: string, source: Source, known: readonly string[]) {
    for (const key of Object.keys(source))
      if (!known.includes(key))
        this.problems.push(
          `${path ? `${path}.` : ''}${key} isn't a Forgekeeper option; ignoring it`,
        );
  }

  // An object option: an absent one reads as empty, and an invalid one as
  // its defaults.
  object(path: string, value: unknown, known: readonly string[]): Source {
    if (value === undefined) return {};
    if (!isObject(value)) {
      this.ignore(path, 'must be an object', 'the defaults');
      return {};
    }
    this.unknown(path, value, known);
    return value;
  }

  boolean(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    this.ignore(path, 'must be true or false', String(fallback));
    return fallback;
  }

  choice<T extends string>(path: string, value: unknown, choices: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (choices.includes(value as T)) return value as T;
    this.ignore(path, `must be one of ${quoted(choices)}`, `"${fallback}"`);
    return fallback;
  }

  pollSeconds(value: unknown): number {
    if (value === undefined) return DEFAULT_POLL_SECONDS;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    this.ignore('pollSeconds', 'must be a positive number', String(DEFAULT_POLL_SECONDS));
    return DEFAULT_POLL_SECONDS;
  }

  hosts(path: string, value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((host) => typeof host !== 'string'))
      this.ignore(path, 'must be a list of host names', 'the host names in it');
  }

  // A list replaces the defaults, and an invalid value keeps them.
  reviewBots(value: unknown): ReviewBots {
    if (value === undefined) return DEFAULT_REVIEW_BOTS;
    const fail = (reason: string) => {
      this.ignore('reviewBots', reason, 'the defaults');
      return DEFAULT_REVIEW_BOTS;
    };
    if (!isObject(value))
      return fail('must map hosts to lists of usernames, such as {"gitlab.com": ["name"]}');
    const bots: Record<string, string[]> = {};
    for (const [key, names] of Object.entries(value)) {
      const host = key.toLowerCase();
      if (!HOST.test(host)) return fail(`has ${JSON.stringify(key)}, which isn't a host name`);
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
        return fail(`must list usernames for ${key}`);
      const wanted = (names as string[]).map((name) => name.toLowerCase());
      const invalid = wanted.filter((name) => !USERNAME.test(name));
      if (invalid.length)
        return fail(
          `lists ${JSON.stringify(invalid)} for ${key}, but usernames must be exact, without wildcards`,
        );
      bots[host] = [...new Set([...(bots[host] ?? []), ...wanted])];
    }
    return bots;
  }

  policy(event: keyof LifecycleExecution, value: unknown): EventPolicy {
    const path = `lifecycleExecution.${event}`;
    if (value === undefined) return NOTIFY;
    const fail = (reason: string) => {
      this.ignore(path, reason, '"notify"');
      return NOTIFY;
    };
    if (!isObject(value)) return fail('must be an object, such as {"mode": "notify"}');
    this.unknown(path, value, ['mode', 'actions']);
    if (!MODES.includes(value.mode as ExecutionMode))
      return fail(`mode must be one of ${quoted(MODES)}`);
    const mode = value.mode as ExecutionMode;
    const listed = value.actions ?? [];
    if (!Array.isArray(listed)) return fail('actions must be a list');
    const unsupported = listed.filter(
      (action) => !ACTIONS[event].includes(action as ExecutionAction),
    );
    if (unsupported.length)
      return fail(
        `actions has ${JSON.stringify(unsupported)}, but supports only ${quoted(ACTIONS[event])}`,
      );
    const actions = [...new Set(listed as ExecutionAction[])];
    if (mode === 'notify') {
      if (actions.length) this.ignore(path, 'mode "notify" takes no actions', 'no actions');
      return NOTIFY;
    }
    if (!actions.length) return fail(`mode "${mode}" needs at least one action`);
    return { mode, actions };
  }
}

export function statusOptions(options: unknown): StatusOptions {
  const read = new Reader();
  const source = isObject(options) ? options : {};
  read.unknown('', source, OPTIONS);
  const watch = read.object('watch', source.watch, Object.keys(DEFAULT_WATCH));
  const delivery = read.object('delivery', source.delivery, Object.keys(DEFAULT_DELIVERY));
  const execution = read.object(
    'lifecycleExecution',
    source.lifecycleExecution,
    Object.keys(ACTIONS),
  );
  read.hosts('hosts', source.hosts);
  read.hosts('githubHosts', source.githubHosts);
  const watched = (key: keyof Watch) =>
    read.boolean(`watch.${key}`, watch[key], DEFAULT_WATCH[key]);
  const delivered = (key: keyof Delivery) =>
    read.choice(`delivery.${key}`, delivery[key], DELIVERIES, DEFAULT_DELIVERY[key]);
  return {
    enabled: read.boolean('status', source.status, true),
    pollSeconds: read.pollSeconds(source.pollSeconds),
    watch: {
      humanReviews: watched('humanReviews'),
      automatedReviews: watched('automatedReviews'),
      reviewBots: watched('reviewBots'),
      lifecycle: watched('lifecycle'),
    },
    reviewBots: read.reviewBots(source.reviewBots),
    delivery: { reviews: delivered('reviews'), lifecycle: delivered('lifecycle') },
    lifecycleExecution: { parentMerged: read.policy('parentMerged', execution.parentMerged) },
    automation: read.automation(source.automation),
    problems: read.problems,
  };
}

// Whether the username is one of the host's review bots, ignoring case, as
// forges do.
export function matchesReviewBot(bots: ReviewBots, host: string, username: string): boolean {
  return bots[host.toLowerCase()]?.includes(username.toLowerCase()) ?? false;
}
