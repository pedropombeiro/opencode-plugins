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
  // Option values that were ignored, and why, for a notice at startup.
  problems: string[];
}

// What Forgekeeper watches. Turning a source off stops everything that
// depends on it: without `lifecycle`, nothing notices merges, so nothing is
// retargeted either.
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

// What Forgekeeper does about a lifecycle event besides reporting it.
// `notify` does nothing more. `prepare` works out the event's actions and
// reports them. `apply` also carries them out.
export type ExecutionMode = 'notify' | 'prepare' | 'apply';
export type ExecutionAction = 'retarget';

export interface EventPolicy {
  mode: ExecutionMode;
  // What `prepare` works out and `apply` carries out. Empty for `notify`.
  actions: ExecutionAction[];
}

export interface LifecycleExecution {
  // A PR/MR that another target of the session builds on merged.
  parentMerged: EventPolicy;
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
const DELIVERIES: readonly FeedbackDelivery[] = ['inbox', 'passive', 'summary'];
const MODES: readonly ExecutionMode[] = ['notify', 'prepare', 'apply'];
// The actions each event supports.
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
  'hosts',
  'githubHosts',
];

type Source = Record<string, unknown>;

const isObject = (value: unknown): value is Source =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ');

// Reads options, collecting each ignored value as a problem that names its
// path and what's used instead.
class Reader {
  readonly problems: string[] = [];

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

  // An event's policy. Anything invalid falls back to `notify`, so a mistake
  // never grants more than intended.
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
    problems: read.problems,
  };
}

// Whether the username is one of the host's review bots, ignoring case, as
// forges do.
export function matchesReviewBot(bots: ReviewBots, host: string, username: string): boolean {
  return bots[host.toLowerCase()]?.includes(username.toLowerCase()) ?? false;
}
