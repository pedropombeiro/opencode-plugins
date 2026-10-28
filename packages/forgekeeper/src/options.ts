// The PR/MR status options, from the plugin's `opencode.json` entry. The
// server entry point reads them; the CLI only renders what the server sends.
export interface StatusOptions {
  // `reviewStatus: false` keeps only session targets and titles.
  enabled: boolean;
  pollSeconds: number;
  notifyAutomatedReviews: boolean;
  notifyHumanReviews: boolean;
  // Bot accounts whose comments count as review feedback, such as security
  // reviewers: exact usernames, by host.
  reviewBots: ReviewBots;
  feedbackDelivery: FeedbackDelivery;
  // Merge conflicts and merges of the session's PRs/MRs.
  notifyLifecycle: boolean;
  lifecycleDelivery: FeedbackDelivery;
  lifecycleExecution: LifecycleExecution;
  // Option values that were ignored, and why, for a notice at startup.
  problems: string[];
}

// What a feedback update does besides entering the inbox. `passive` queues a
// session message that starts no turn. `summary` starts a tool-free turn that
// summarizes the feedback.
export type FeedbackDelivery = 'inbox' | 'passive' | 'summary';

// What Forgekeeper does about a lifecycle event besides telling the session.
// `notify` does nothing more. `prepare` works out the follow-up and reports
// it. `apply` also carries out the actions listed for the event.
export type ExecutionMode = 'notify' | 'prepare' | 'apply';
export type ExecutionAction = 'retarget';

export interface EventPolicy {
  mode: ExecutionMode;
  actions: ExecutionAction[];
}

export interface LifecycleExecution {
  // A PR/MR that another target of the session builds on merged.
  parentMerged: EventPolicy;
  // A PR/MR started to conflict with its target branch. Only `notify` exists.
  conflict: EventPolicy;
}

// Review bot usernames by host, both lowercase.
export type ReviewBots = Readonly<Record<string, readonly string[]>>;

// GitLab.com's security review agents for `gitlab-org`. Duo Security Review
// has one account per top-level group, so other groups add theirs. Names are
// exact: anyone can create a bot account whose name only starts the same.
export const DEFAULT_REVIEW_BOTS: ReviewBots = {
  'gitlab.com': ['duo-security-review-gitlab-org', 'ai-appsec-security-mr-reviewer-gitlab-org'],
};

const HOST = /^[a-z0-9.-]+(:\d+)?$/;
const USERNAME = /^[a-z0-9_.[\]-]+$/;

// The configured usernames. An invalid value keeps the defaults, with a
// problem saying so.
function reviewBots(value: unknown, problems: string[]): ReviewBots {
  if (value === undefined) return DEFAULT_REVIEW_BOTS;
  const fail = (reason: string) => {
    problems.push(`reviewBots: ${reason}; using the defaults`);
    return DEFAULT_REVIEW_BOTS;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('must map hosts to lists of usernames, such as {"gitlab.com": ["name"]}');
  const bots: Record<string, string[]> = {};
  for (const [key, names] of Object.entries(value)) {
    const host = key.toLowerCase();
    if (!HOST.test(host)) return fail(`${JSON.stringify(key)} isn't a host name`);
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
      return fail(`${key} must list usernames`);
    const wanted = (names as string[]).map((name) => name.toLowerCase());
    const invalid = wanted.filter((name) => !USERNAME.test(name));
    if (invalid.length)
      return fail(
        `${key} lists ${JSON.stringify(invalid)}, but usernames must be exact, without wildcards`,
      );
    bots[host] = [...new Set([...(bots[host] ?? []), ...wanted])];
  }
  return bots;
}

// Whether the username is one of the host's review bots, ignoring case, as
// forges do.
export function matchesReviewBot(bots: ReviewBots, host: string, username: string): boolean {
  return bots[host.toLowerCase()]?.includes(username.toLowerCase()) ?? false;
}

const DELIVERIES = new Set<unknown>(['inbox', 'passive', 'summary']);
const MODES = new Set<unknown>(['notify', 'prepare', 'apply']);
// The actions each event supports.
const ACTIONS: Record<keyof LifecycleExecution, ReadonlySet<ExecutionAction>> = {
  parentMerged: new Set(['retarget']),
  conflict: new Set(),
};

const NOTIFY: EventPolicy = { mode: 'notify', actions: [] };

// An event's policy. Anything invalid or unsupported falls back to `notify`,
// so a mistake never grants more than intended.
function eventPolicy(
  event: keyof LifecycleExecution,
  value: unknown,
  problems: string[],
): EventPolicy {
  if (value === undefined) return NOTIFY;
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const fail = (reason: string) => {
    problems.push(`lifecycleExecution.${event}: ${reason}; using "notify"`);
    return NOTIFY;
  };
  if (!MODES.has(source.mode)) return fail('mode must be "notify", "prepare", or "apply"');
  const mode = source.mode as ExecutionMode;
  const listed = source.actions ?? [];
  if (!Array.isArray(listed)) return fail('actions must be a list');
  const unsupported = listed.filter((action) => !ACTIONS[event].has(action as ExecutionAction));
  if (unsupported.length) return fail(`unsupported actions ${JSON.stringify(unsupported)}`);
  const actions = [...new Set(listed as ExecutionAction[])];
  if (mode !== 'notify' && ACTIONS[event].size === 0) return fail(`"${mode}" isn't supported yet`);
  if (mode === 'apply' && actions.length === 0) return fail('"apply" needs at least one action');
  return { mode, actions: mode === 'notify' ? [] : actions };
}

export function statusOptions(options: unknown): StatusOptions {
  const source = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const poll = Number(source.pollSeconds);
  const problems: string[] = [];
  const execution =
    source.lifecycleExecution && typeof source.lifecycleExecution === 'object'
      ? (source.lifecycleExecution as Record<string, unknown>)
      : {};
  if (source.lifecycleExecution !== undefined && source.lifecycleExecution !== execution)
    problems.push('lifecycleExecution must be an object; using "notify"');
  return {
    enabled: source.reviewStatus !== false,
    pollSeconds: poll > 0 ? poll : 120,
    // `notifyDuoReview` is the option's former name.
    notifyAutomatedReviews: (source.notifyAutomatedReviews ?? source.notifyDuoReview) !== false,
    notifyHumanReviews: source.notifyHumanReviews !== false,
    reviewBots: reviewBots(source.reviewBots, problems),
    feedbackDelivery: DELIVERIES.has(source.reviewFeedbackDelivery)
      ? (source.reviewFeedbackDelivery as FeedbackDelivery)
      : 'inbox',
    notifyLifecycle: source.notifyLifecycle !== false,
    lifecycleDelivery: DELIVERIES.has(source.lifecycleDelivery)
      ? (source.lifecycleDelivery as FeedbackDelivery)
      : 'inbox',
    lifecycleExecution: {
      parentMerged: eventPolicy('parentMerged', execution.parentMerged, problems),
      conflict: eventPolicy('conflict', execution.conflict, problems),
    },
    problems,
  };
}
