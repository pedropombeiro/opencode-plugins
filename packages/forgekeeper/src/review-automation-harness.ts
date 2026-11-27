import type { Plugin } from '@opencode/plugin';
import type { AutomationEnvironmentProvider } from './automation-environment';
import type { FeedbackItem, InboxState } from './feedback-inbox';
import type { CommentDetail, FailedJob } from './forge';
import { linkedMetadata, presenceKey } from './linked-session';
import type { AutomationRule } from './options';
import { PLUGIN_ID } from './plugin-id';
import {
  automationBatch,
  createReviewAutomation,
  type AutomationHost,
  type AutomationRecord,
  type AutomationState,
  type AutomationStatus,
  type LinkedRecord,
} from './review-automation';
import { createAutomationHost, type AutomationDependencies } from './review-automation-host';
import { createReviewClaims, type ExecutionClaim } from './review-claim';
import { preparationMessageID } from './review-preparation';
import { createSummaryDelivery } from './summary-delivery';

export const url = 'https://gitlab.com/team/project/-/merge_requests/1';
export const rule = {
  on: 'review' as const,
  host: 'gitlab.com',
  projects: ['team/project'],
  reviewers: ['gitlabduo'],
  action: 'prepare' as const,
};
export const item: FeedbackItem = {
  id: 'batch',
  sessionID: 'one',
  url,
  title: 'Feedback',
  links: [`${url}#note_1`],
  commentIDs: ['1'],
  at: 100,
  automationAllowed: true,
};
export const job: FailedJob = { id: 'j1', name: 'rspec', stage: 'test', url: `${url}/jobs/1` };
export const finding: CommentDetail = {
  id: '1',
  url: `${url}#note_1`,
  username: 'gitlabduo',
  body: 'A finding',
  authorID: '42',
};

export function fixture(overrides: Partial<AutomationHost> = {}) {
  const records = new Map<string, AutomationRecord>();
  const statuses: AutomationStatus[] = [];
  let state: InboxState = { items: [item], paused: false };
  const claims = new Map<string, ExecutionClaim>();
  let submits = 0;
  const redelivered: string[] = [];
  const host: AutomationHost = {
    rules: [rule],
    ref: () => ({ forge: 'gitlab', host: 'gitlab.com', project: 'team/project', iid: '1' }),
    read: async (batch) => structuredClone(records.get(batch)),
    list: async () => [...records.values()].map((record) => structuredClone(record)),
    save: async (record, expected) => {
      if (JSON.stringify(records.get(record.batch)) !== JSON.stringify(expected)) return false;
      records.set(record.batch, structuredClone(record));
      return true;
    },
    start: async (record, expected) => {
      if (
        JSON.stringify(records.get(record.batch)) !== JSON.stringify(expected) ||
        claims.has(record.item.url)
      )
        return false;
      claims.set(record.item.url, {
        batch: record.batch,
        messageID: record.messageID!,
        sessionID: record.item.sessionID,
      });
      records.set(record.batch, structuredClone(record));
      return true;
    },
    finish: async (record, expected) => {
      if (JSON.stringify(records.get(record.batch)) !== JSON.stringify(expected)) return false;
      records.set(record.batch, structuredClone(record));
      const claim = claims.get(record.item.url);
      if (claim?.batch === record.batch && claim.messageID === record.messageID)
        claims.delete(record.item.url);
      return true;
    },
    status: async (_item, status) => {
      statuses.push(status);
    },
    inbox: async () => state,
    associations: async () => ['one'],
    exists: async () => true,
    findings: async () => [finding],
    failures: async () => ({
      pipeline: { id: 'p1' },
      jobs: [job],
      unlisted: false,
      complete: true,
    }),
    pipelineDone: async () => false,
    model: async () => 'gitlab/strong',
    validate: async () => ({ placement: 'session', rules: host.rules }),
    redeliver: (entry) => void redelivered.push(entry.id),
    wait: async () => {},
    sleep: async () => {},
    claim: {
      acquire: async (claimUrl, value) => {
        if (claims.has(claimUrl)) return false;
        claims.set(claimUrl, value);
        return true;
      },
      read: async (claimUrl) => claims.get(claimUrl),
      release: async (claimUrl) => {
        claims.delete(claimUrl);
      },
    },
    submit: async () => {
      submits++;
    },
    outcome: async () => 'completed',
    closing: () => false,
    error: (error) => {
      throw error;
    },
    now: () => 100,
    ...overrides,
  };
  const automation = createReviewAutomation(host);
  const batch = automationBatch(item);
  return {
    automation,
    host,
    records,
    statuses,
    redelivered,
    submits: () => submits,
    pause: () => {
      state = { ...state, paused: true };
    },
    acknowledge: () => {
      state = { ...state, items: [] };
    },
    setItems: (items: FeedbackItem[]) => {
      state = { ...state, items };
    },
    record: () => records.get(batch)!,
    claim: () => claims.get(url),
    settled: () => Promise.all(automation.tasks()),
    // Stores an attempt as a reload finds it, with its execution claim once it runs.
    async seed(seedState: AutomationState): Promise<AutomationRecord> {
      const messageID = preparationMessageID(batch, 1);
      const record: AutomationRecord = {
        item,
        batch,
        state: seedState,
        at: 100,
        attempt: 1,
        messageID,
      };
      records.set(batch, structuredClone(record));
      if (seedState === 'running') claims.set(url, { batch, messageID, sessionID: 'one' });
      return record;
    },
  };
}

export const linked = {
  stage: 'submitting' as const,
  provider: 'fixture',
  version: 1,
  ownerDirectory: '/repo',
  head: 'abc',
  sourceProject: 'team/project',
  sourceBranch: 'feature',
  state: { resource: 'box:123', session: 'linked' },
  prompt: 'task',
};

export function worktreeFixture(
  overrides: Partial<AutomationHost> & {
    provision?: AutomationEnvironmentProvider['provision'];
    verifyExecution?: AutomationEnvironmentProvider['verify'];
  } = {},
) {
  const waited: string[] = [];
  const submitted: AutomationRecord[] = [];
  const notices: Array<[string, AutomationState]> = [];
  const f: ReturnType<typeof fixture> = fixture({
    validate: async () => ({ placement: 'environment', rules: [rule] }),
    wait: async (sessionID) => void waited.push(sessionID),
    environments: {
      default: 'fixture',
      providers: [
        {
          id: 'fixture',
          version: 1,
          recover: async () => {},
          async provision(_record, update) {
            await update({
              stage: 'provisioning',
              ownerDirectory: '/repo',
              head: 'abc',
              sourceProject: 'team/project',
              sourceBranch: 'feature',
            });
            await update({ state: { resource: 'box:123' } });
            return update({ state: linked.state });
          },
          verify: async () => {},
          submit: (record) => f.host.submit(record, record.execution.prompt),
          exists: (record) => f.host.exists(record.execution!.state.session as string),
          wait: (record) => f.host.wait(record.execution!.state.session as string),
          outcome: (record) =>
            f.host.outcome({
              batch: record.batch,
              messageID: record.messageID!,
              sessionID: record.item.sessionID,
            }),
          matchesSession: (record, sessionID) => record.execution!.state.session === sessionID,
          startContext: () => {
            throw new Error('Unused');
          },
          describe: async () => [],
          sweep: async () => [],
          ...(overrides.provision ? { provision: overrides.provision } : {}),
          ...(overrides.verifyExecution ? { verify: overrides.verifyExecution } : {}),
        },
      ],
    },
    notify: async (record, phase) => void notices.push([phase, record.state]),
    // The worktree's first request records the start of the turn.
    submit: async (record) => {
      submitted.push(structuredClone(record));
      f.records.set(record.batch, { ...f.records.get(record.batch)!, startedAt: 100 });
    },
    ...overrides,
  });
  return { ...f, waited, submitted, notices };
}

export type Message = Awaited<ReturnType<Plugin.Context['session']['context']>>[number];
export const hostBatch = 'a'.repeat(64);
export const messageID = preparationMessageID(hostBatch, 1);
export const hostItem = {
  id: 'item',
  sessionID: 'one',
  url: 'https://gitlab.com/group/project/-/merge_requests/1',
  title: 'Review',
  links: [],
  at: 1,
};
export const record: AutomationRecord = {
  batch: hostBatch,
  item: hostItem,
  messageID,
  state: 'running',
  attempt: 1,
  at: 1,
  startedAt: 10,
};
export const claim = { batch: hostBatch, sessionID: 'one', messageID };
export const message = (type: string, id: string, at: number, extra = {}) =>
  ({ type, id, time: { created: at }, ...extra }) as Message;

export async function historyFixture(messages: Message[], idle?: number, stored = record) {
  const claims = createReviewClaims(':memory:');
  await claims.records.save(stored);
  const ctx = {
    location: { directory: '/repo' },
    session: {
      context: async () => messages,
      get: async () => ({
        time: { idle },
        outcome: idle ? 'succeeded' : undefined,
        location: { directory: '/repo' },
      }),
    },
  } as unknown as Plugin.Context;
  const make = () =>
    createAutomationHost(ctx, { reviewClaims: claims } as AutomationDependencies, {
      rules: [],
      closing: () => false,
      inbox: {
        list: async () => ({ items: [hostItem], paused: false }),
        automation: async () => {},
      },
      relay: async () => {},
      deliverable: async () => true,
      readFeedback: async () => undefined,
      scan: async () => [],
      missingSession: () => false,
      redeliver: () => {},
      report: () => {},
      signal: new AbortController().signal,
    });
  return { make, claims };
}

export const hostUrl = 'https://gitlab.com/group/project/-/merge_requests/1';
export const head = 'c0ffee'.repeat(7);
export const hostReview = { ...hostItem, id: 'r1', url: hostUrl };
export const hostRule = {
  on: 'review' as const,
  host: 'gitlab.com',
  projects: ['group/project'],
  reviewers: ['duo'],
  action: 'prepare' as const,
};

export interface HostFixtureOptions {
  rules?: AutomationRule[];
  checkout?: string;
  sessions?: Record<string, Record<string, unknown>>;
  storage?: Record<string, unknown>;
  // Overrides of the PR/MR the forge reports.
  request?: Record<string, unknown>;
  viewer?: string;
  accounts?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // The pages of sessions that listing the project returns.
  pages?: Array<Array<Record<string, unknown>>>;
  // Transcripts by session ID, for `ctx.session.context`.
  transcripts?: Record<string, Message[]>;
  // What `git status --short` reports in the worktree.
  status?: string;
  items?: AutomationRecord['item'][];
}

// What `git status --short` reports in the worktree.
let worktreeStatus = '';
// Git in a worktree at `head` on `feature`.
const worktreeExec = (async (_file: string, args: string[]) => {
  let stdout = '';
  if (args.includes('--show-toplevel')) {
    stdout = '/repo';
  } else {
    switch (args[0]) {
      case 'rev-parse':
        stdout = head;
        break;
      case 'symbolic-ref':
        stdout = 'feature';
        break;
      case 'status':
        stdout = worktreeStatus;
        break;
    }
  }
  return {
    code: ['symbolic-ref', 'rev-parse', 'status'].includes(args[0]) ? 0 : 1,
    stderr: '',
    stdout,
  };
}) as unknown as AutomationDependencies['exec'];

export function hostFixture(options: HostFixtureOptions = {}) {
  worktreeStatus = options.status ?? '';
  const sessions: Record<string, Record<string, unknown>> = structuredClone({
    one: { id: 'one', agent: 'build', time: {}, location: { directory: '/repo' } },
    ...options.sessions,
  });
  const storage: Record<string, unknown> = { ...options.storage };
  const request = {
    forge: 'gitlab',
    url: hostUrl,
    state: 'opened',
    sourceProject: 'group/project',
    sourceBranch: 'feature',
    headSha: head,
    authorID: 'author',
    ...options.request,
  };
  const deps = {
    exec: worktreeExec,
    forges: {
      forHost: () => ({ findByNumber: async () => structuredClone(request) }),
      repository: async () => ({
        kind: 'repository',
        repository: {
          source: { host: 'gitlab.com', path: 'group/project' },
          sourceBranch: options.checkout ?? 'feature',
          head,
        },
      }),
    },
    viewerID: async () => options.viewer ?? 'author',
    reviewerID: async (_ref: unknown, name: string) => options.accounts?.[name],
    ...(options.now ? { now: options.now } : {}),
  } as unknown as AutomationDependencies;
  const pages = options.pages ?? [[]];
  const listed: unknown[] = [];
  const synthetic: Array<Record<string, unknown>> = [];
  const cleanedUp: string[][] = [];
  const ctx = {
    location: { directory: '/repo', project: { id: 'project' } },
    storage: {
      get: async (key: string) => storage[key],
      set: async (key: string, value: unknown) => {
        storage[key] = value;
      },
    },
    plugin: {
      list: async () => ({ data: [{ id: PLUGIN_ID, state: { status: 'active' } }] }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions[sessionID];
        if (!session) throw new Error('Session not found');
        return session;
      },
      update: async ({
        sessionID,
        archived,
        metadata,
      }: {
        sessionID: string;
        archived?: boolean;
        metadata?: Record<string, unknown>;
      }) => {
        const session = sessions[sessionID] as
          { time?: { archived?: number }; metadata?: Record<string, unknown> } | undefined;
        if (!session) throw new Error('Session not found');
        if (metadata !== undefined) session.metadata = metadata;
        if (archived !== undefined) {
          session.time = { ...session.time, ...(archived ? { archived: 1 } : {}) };
        }
        return session;
      },
      context: async ({ sessionID }: { sessionID: string }) =>
        options.transcripts?.[sessionID] ?? [],
      synthetic: async (input: Record<string, unknown>) => {
        synthetic.push(input);
      },
      list: async (input: { cursor?: number }) => {
        listed.push(input);
        const index = input.cursor ?? 0;
        return {
          data: pages[index].map((session) => ({ location: { directory: '/repo' }, ...session })),
          cursor: { next: index + 1 < pages.length ? index + 1 : null },
        };
      },
    },
  } as unknown as Plugin.Context;
  const summaries = createSummaryDelivery(ctx, deps, {
    closing: () => false,
    inbox: async () => ({ items: [], paused: false }),
    deliverable: async () => true,
    scan: async () => [],
    write: () => {},
    report: () => {},
  });
  const claims = createReviewClaims(':memory:');
  const automation = createAutomationHost(
    ctx,
    { ...deps, reviewClaims: claims },
    {
      rules: options.rules ?? [hostRule],
      relay: summaries.relay,
      closing: () => false,
      inbox: {
        list: async () => ({ items: options.items ?? [hostReview], paused: false }),
        automation: async () => {},
      },
      deliverable: async () => true,
      readFeedback: async () => undefined,
      scan: async () =>
        Object.keys(sessions).map((id) => ({
          key: `sessions/${id}`,
          value: { targets: [{ url: hostUrl }] },
        })),
      missingSession: (error) => /not found/i.test(String(error)),
      redeliver: () => {},
      report: () => {},
      sessionsCleanedUp: (ids) => cleanedUp.push(ids),
      signal: new AbortController().signal,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  );
  return {
    ...automation,
    claims,
    storage,
    sessions,
    request,
    listed,
    synthetic,
    cleanedUp,
    summaries,
    close: () => claims.close(),
  };
}

// A linked session's attempt, its owner in /owner, the worktree here.
export const linkedAttempt = (entry: AutomationRecord['item'] = hostReview): LinkedRecord => ({
  ...record,
  item: entry,
  state: 'running',
  startedAt: undefined,
  execution: {
    stage: 'submitting',
    provider: 'local-worktree',
    version: 1,
    ownerDirectory: '/owner',
    head,
    sourceProject: 'group/project',
    sourceBranch: 'feature',
    state: { directory: '/repo', sessionID: 'linked' },
    prompt: 'task',
  },
});

export const linkedSessions = {
  one: { id: 'one', time: {}, location: { directory: '/owner' } },
  linked: {
    id: 'linked',
    agent: 'build',
    time: {},
    location: { directory: '/repo' },
    metadata: linkedMetadata('one', hostBatch, 'linked'),
  },
};

// The owner's instance, running with `rules`, with the update pending
// and the PR/MR targeted.
export const ownerReady = (rules: AutomationRule[], at: number, entry = hostReview) => ({
  [presenceKey('/owner')]: { at, instance: 'owner', rules },
  [`feedback-inbox/${encodeURIComponent('/owner')}`]: { items: [entry], paused: false },
  'sessions/one': { targets: [{ url: hostUrl }] },
});
