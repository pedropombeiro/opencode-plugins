import { expect } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import type { InboxState } from './feedback-inbox';
import type {
  CommentDetail,
  FeedbackSnapshot,
  FeedbackTarget,
  Forge,
  GitHubPullRequest,
  GitLabMergeRequest,
  IssueSnapshot,
  LinkedNote,
  ReviewComment,
  ReviewRef,
  ReviewRequest,
  ReviewRequestHistory,
} from './forge';
import { kinds, traits, type ForgeCatalog } from './forges';
import type { RemoteProject } from './git';
import { FETCH_INTERVAL, SETTLE_TIME } from './human-review-watch';
import type { TitleLookups } from './lookups';
import type { MonitoringStatus } from './monitoring-status';
import { createReviewClaims } from './review-claim';
import { LINKED_NOTE_TOOL } from './review-summary';
import { setupServer } from './server';
import type { CleanupResult, CleanupScanResult } from './session-cleanup';
import type { Snapshot } from './store';
import { flush } from './testing';

export type Tool = {
  name: string;
  options?: { codemode?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<unknown>;
};
export type Command = {
  name: string;
  execute: (input: {
    sessionID: string;
    prompt: { text: string };
    delivery: string;
  }) => Promise<void>;
};
export type Hook = (event: {
  sessionID: string;
  system: { type: string; text: string }[];
}) => Promise<void>;

// A queued message stays out of the context until a step delivers it.
export type Transcript = Array<{
  type: string;
  id: string;
  metadata?: unknown;
  queued?: boolean;
  time?: { created: number };
}>;

export interface Options {
  reviewClaims?: ReturnType<typeof createReviewClaims>;
  reviewerID?: (ref: ReviewRef, username: string) => Promise<string | undefined>;
  // The signed-in account. Defaults to `me`, who wrote every PR/MR.
  viewerID?: (ref: ReviewRef) => Promise<string | undefined>;
  storage?: Map<string, unknown>;
  branch?: { current: string; default: string };
  sourceBranches?: Map<string, string>;
  failingSession?: boolean;
  pluginOptions?: Record<string, unknown>;
  // Turns PR/MR status on, with this forge for its lookups.
  status?: Forge;
  failingInbox?: number;
  // Reads review comments for human feedback, instead of the forge.
  feedback?: (request: ReviewRequest) => Promise<FeedbackSnapshot | undefined>;
  details?: (request: FeedbackTarget, ids: string[]) => Promise<CommentDetail[]>;
  // Reads requests for your review. Defaults to a PR/MR without any.
  reviewRequests?: (request: ReviewRequest) => Promise<ReviewRequestHistory | undefined>;
  linkedNote?: (request: FeedbackTarget, url: string) => Promise<LinkedNote | undefined>;
  // Shared with another instance, such as the one after a reload.
  transcripts?: Map<string, Transcript>;
  now?: () => number;
  holdInbox?: boolean;
  // Shared with another instance, such as one for another checkout.
  sessions?: Map<
    string,
    {
      title: string;
      location: { directory: string };
      parentID: string | undefined;
      fork?: { sessionID: string };
      metadata?: Record<string, unknown>;
    }
  >;
  // The instance's checkout. Defaults to /repo.
  directory?: string;
  activity?: number;
  ignoreServerArchive?: boolean;
  permissionDecision?: (input: {
    sessionID: string;
    agent?: string;
    action: string;
    resources: readonly string[];
  }) => 'allow' | 'deny' | 'ask' | Promise<'allow' | 'deny' | 'ask'>;
  permissionReply?: 'allow' | 'reject' | (() => 'allow' | 'reject' | Promise<'allow' | 'reject'>);
  onPrompt?: () => Promise<void> | void;
}

// A GitLab forge whose PRs/MRs the test changes between lookups. A gated
// lookup waits for `open()`, then reads the PR/MR as it is at that point.
export class StatusForge implements Forge {
  readonly traits;
  readonly requests = new Map<string, ReviewRequest>();
  readonly lookups: string[] = [];
  branch: GitLabMergeRequest[] = [];
  private gates: Array<() => void> = [];
  gated = false;

  constructor(kind: 'gitlab' | 'github' = 'gitlab') {
    this.traits = traits(kind);
  }

  set(project: string, iid: string, overrides: Partial<GitLabMergeRequest> = {}) {
    this.requests.set(`${project}!${iid}`, {
      forge: 'gitlab',
      iid,
      url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
      state: 'opened',
      conflicts: false,
      conflictsKnown: true,
      awaitingReviewers: [],
      targetProject: project,
      targetBranch: 'main',
      sourceProject: project,
      sourceBranch: `branch-${iid}`,
      authorID: 'me',
      ...overrides,
    } as GitLabMergeRequest);
  }

  setPR(project: string, iid: string, overrides: Partial<GitHubPullRequest> = {}) {
    this.requests.set(`${project}!${iid}`, {
      forge: 'github',
      iid,
      url: `https://github.com/${project}/pull/${iid}`,
      state: 'opened',
      draft: false,
      conflicts: false,
      conflictsKnown: true,
      awaitingReviewers: [],
      targetProject: project,
      targetBranch: 'main',
      sourceProject: project,
      sourceBranch: `branch-${iid}`,
      authorID: 'me',
      ...overrides,
    } as GitHubPullRequest);
  }

  open() {
    this.gated = false;
    for (const gate of this.gates.splice(0)) gate();
  }

  readonly failingLookups = new Set<string>();

  async findByNumber(projects: readonly RemoteProject[], number: string) {
    const key = `${projects[0].path}!${number}`;
    this.lookups.push(key);
    if (this.gated) await new Promise<void>((resolve) => this.gates.push(resolve));
    if (this.failingLookups.has(key)) throw new Error(`Lookup failed for ${key}`);
    return this.requests.get(key);
  }

  async findByBranch() {
    return this.branch;
  }

  async findNumberByBranch() {
    return this.branch[0]?.iid;
  }

  readonly markedReady: ReviewRef[] = [];
  readonly issues = new Map<string, IssueSnapshot>();
  readonly issueReads: string[] = [];
  readonly issueReadTargets: string[] = [];

  async issue(ref: ReviewRef) {
    this.issueReads.push(ref.iid);
    this.issueReadTargets.push(`${ref.project}#${ref.iid}`);
    return this.issues.get(`${ref.project}#${ref.iid}`);
  }

  async sourceBranch() {
    return undefined;
  }

  async markReady(ref: ReviewRef, options?: { beforeMutate?: () => Promise<void> | void }) {
    await options?.beforeMutate?.();
    this.markedReady.push(ref);
    const key = `${ref.project}!${ref.iid}`;
    const existing = this.requests.get(key);
    if (existing) this.requests.set(key, { ...existing, draft: false });
  }
}

export const catalogFor = (forge: Forge): ForgeCatalog => ({
  kinds,
  kind: (host) => (host === `${forge.traits.kind}.com` ? forge.traits.kind : undefined),
  forHost: (host) => (host === `${forge.traits.kind}.com` ? forge : undefined),
  projects: async () => [{ host: 'gitlab.com', path: 'group/project' }],
  repository: async () => ({
    kind: 'repository',
    repository: {
      head: 'abc',
      branch: 'feature',
      sourceBranch: 'feature',
      source: { host: 'gitlab.com', path: 'group/project' },
      targets: [],
    },
  }),
});

export const defaultSessions = () =>
  new Map([
    [
      'one',
      {
        title: '[#123, !45] Review changes',
        location: { directory: '/repo' },
        parentID: undefined as string | undefined,
        fork: undefined as { sessionID: string } | undefined,
      },
    ],
    [
      'two',
      {
        title: 'Other session',
        location: { directory: '/repo' },
        parentID: undefined as string | undefined,
      },
    ],
  ]);

// Lets the plugin finish the work that the doubles' promises release. None of
// that work waits for a timer, so one turn of the event loop is enough.
export const settle = flush;

export const duoComment = (url: string, id: string): ReviewComment => ({
  id,
  order: Number(id),
  url: `${url}#note_${id}`,
  editedAt: 0,
  resolved: false,
  bot: true,
  authorID: 'duo',
  username: 'GitLabDuo',
  automated: { reviewer: 'GitLab Duo', finding: true, runID: `run-${id}`, status: 'FINISHED' },
});

// Where the server stores a pending automated-review notification.
export const pendingRecord = (sessionID: string, url: string) =>
  `status/pending/${encodeURIComponent(sessionID)}/${encodeURIComponent(url)}`;

// Every comment ID that stored feedback records count as announced.
export const announcedIn = (storage: Map<string, unknown>) =>
  [...storage]
    .filter(([key]) => key.startsWith('status/feedback/'))
    .flatMap(([, record]) => (record as { announced: string[] }).announced);

// Stand in for OpenCode's provider message classes, one per role, which
// validate their fields.
export class ProviderMessage {
  readonly role: string;
  readonly content: Array<{ type: string; text: string }>;
  constructor(input: { role: string; content: Array<{ type: string; text: string }> }) {
    if (input.role !== 'user') throw new Error('Schema validation failed');
    this.role = input.role;
    this.content = input.content;
  }
}

export class ToolMessage {
  readonly role: string;
  readonly content: Array<{ type: string; text: string }>;
  constructor(input: { role: string; content: Array<{ type: string; text: string }> }) {
    if (input.role !== 'tool') throw new Error('Schema validation failed');
    this.role = input.role;
    this.content = input.content;
  }
}

// The text of a replaced request's one message.
export const textOf = (request: { messages: unknown[] }) =>
  (request.messages[0] as ProviderMessage).content[0].text;

export const mr = 'https://gitlab.com/group/project/-/merge_requests/456';
export const nextMr = 'https://gitlab.com/group/project/-/merge_requests/789';
export const issue = 'https://gitlab.com/group/project/-/issues/42';
export const projectA = 'https://gitlab.com/group/a/-/merge_requests/1';
export const projectB = 'https://gitlab.com/group/b/-/merge_requests/1';
export const child = 'https://gitlab.com/group/a/-/merge_requests/2';
export const quiet = { watch: { humanReviews: false } };

export async function harness(options: Options = {}) {
  const storage = options.storage ?? new Map<string, unknown>();
  const reviewClaims = options.reviewClaims ?? createReviewClaims(':memory:');
  const sessions = options.sessions ?? defaultSessions();
  const directory = options.directory ?? '/repo';
  const sourceLookups: ReviewRef[] = [];
  const lookups: TitleLookups = {
    sourceBranch: async (ref) => {
      sourceLookups.push(ref);
      return options.sourceBranches?.get(ref.iid);
    },
  };
  const registeredTools = new Map<string, Tool>();
  let tool!: Tool;
  let linked: Tool | undefined;
  const commands = new Map<string, Command>();
  const entries = new Map<string, Map<string, string>>();
  const entriesOf = (sessionID: string) => {
    if (!entries.has(sessionID)) entries.set(sessionID, new Map());
    return entries.get(sessionID)!;
  };
  const entryWrites: string[] = [];
  let hook!: Hook;
  let promptHook: (event: { sessionID: string }) => Promise<void> = async () => {};
  let compactionHook: Hook | undefined;
  let renames = 0;
  let handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const emitted: Array<{ name: string; data: unknown }> = [];
  const disposed: string[] = [];
  const synthetic: Array<{ sessionID: string; text: string; resume?: boolean }> = [];
  const passive: Array<{
    sessionID: string;
    id?: string;
    text: string;
    resume?: boolean;
    metadata?: unknown;
    delivery?: string;
  }> = [];
  const prompts: Array<{ sessionID: string; id: string; text: string }> = [];
  // What each session's context lists after its first user prompt.
  const transcripts = options.transcripts ?? new Map<string, Transcript>();
  let contextFails = false;
  // The model the session uses, for its requests and its stored selection.
  let model = { providerID: 'gitlab', id: 'strong' };
  let toolHook: (event: { sessionID: string; tool: string }) => Promise<void> = async () => {};
  let permissionHook: (event: {
    sessionID: string;
    effect: string;
    message?: string;
  }) => Promise<void> = async () => {};
  let inboxFailures = options.failingInbox ?? 0;
  let releaseInbox = () => {};
  const inboxGate = options.holdInbox
    ? new Promise<void>((resolve) => (releaseInbox = resolve))
    : undefined;
  let inboxStarted = 0;
  let syntheticStarted = 0;
  // What the next session read does, once: wait for a promise, or fail.
  let nextRead: Promise<void> | Error | undefined;
  // Storage reads of these keys wait, once, for their promise.
  const heldGets = new Map<string, Promise<void>>();
  // Events for the plugin's subscription, which ends when it aborts.
  const events: unknown[] = [];
  let wake = () => {};
  const ctx = {
    rpc: {
      register: async (_definition: unknown, implementation: typeof handlers) => {
        handlers = implementation;
        return {
          events: {
            emit: async (name: string, data: unknown) => void emitted.push({ name, data }),
          },
          dispose: async () => void disposed.push('rpc'),
        };
      },
    },
    location: { directory },
    options: { inbox: true, delivery: { reviews: 'summary' }, ...options.pluginOptions },
    storage: {
      // Copies like durable storage, so later changes in memory don't count as stored.
      get: async (key: string) => {
        const held = heldGets.get(key);
        heldGets.delete(key);
        // Reads the value before waiting, like a read that was slow to return.
        const value = structuredClone(storage.get(key));
        await held;
        return value;
      },
      set: async (key: string, value: unknown) => {
        if (key.startsWith('feedback-inbox/')) {
          inboxStarted++;
          await inboxGate;
          if (inboxFailures > 0) {
            inboxFailures--;
            throw new Error('storage unavailable');
          }
        }
        storage.set(key, structuredClone(value));
      },
      remove: async (key: string) => void storage.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...storage]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value: structuredClone(value) })),
      }),
    },
    session: {
      wait: async () => {},
      prompt: async (input: { sessionID: string; id: string; text: string }) => {
        await options.onPrompt?.();
        prompts.push(input);
        const transcript = transcripts.get(input.sessionID) ?? [];
        transcript.push({ type: 'user', id: input.id, queued: true });
        transcripts.set(input.sessionID, transcript);
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        if (contextFails) throw new Error('context unavailable');
        return [
          ...(options.activity === undefined
            ? []
            : [{ type: 'user', id: 'msg_first', time: { created: options.activity } }]),
          ...(transcripts.get(sessionID) ?? []).filter((message) => !message.queued),
        ];
      },
      instructions: {
        entry: {
          list: async ({ sessionID }: { sessionID: string }) =>
            [...entriesOf(sessionID)].map(([key, value]) => ({ key, value })),
          put: async ({
            sessionID,
            key,
            value,
          }: {
            sessionID: string;
            key: string;
            value: string;
          }) => {
            entryWrites.push(`put ${key}`);
            entriesOf(sessionID).set(key, value);
          },
        },
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.failingSession) throw new Error('unavailable');
        const next = nextRead;
        nextRead = undefined;
        if (next instanceof Error) throw next;
        await next;
        const session = sessions.get(sessionID) as
          | {
              title: string;
              location: { directory: string };
              parentID?: string;
              fork?: { sessionID: string };
              time?: { archived?: number; busy?: number; idle?: number; updated?: number };
            }
          | undefined;
        return session ? { id: sessionID, time: {}, ...session, model } : undefined;
      },
      update: async ({
        sessionID,
        title,
        archived,
      }: {
        sessionID: string;
        title?: string;
        archived?: boolean;
      }) => {
        const session = sessions.get(sessionID)! as {
          title: string;
          time?: { archived?: number };
        };
        if (title !== undefined) {
          session.title = title;
          renames++;
        }
        if (archived !== undefined && !options.ignoreServerArchive) {
          session.time = { ...session.time, archived: archived ? Date.now() : undefined };
        }
      },
      hook: async (name: string, callback: Hook) => {
        if (name === 'prompt') promptHook = callback as unknown as typeof promptHook;
        else if (name === 'compaction') compactionHook = callback;
        else hook = callback;
      },
      synthetic: async (input: (typeof passive)[number]) => {
        if (input.resume !== false) {
          syntheticStarted++;
          synthetic.push(input);
        }
        passive.push(input);
        const transcript = transcripts.get(input.sessionID) ?? [];
        // Like the API, a repeated ID returns the original admission.
        if (!transcript.some((message) => message.id === input.id))
          transcript.push({
            type: 'synthetic',
            id: input.id ?? '',
            metadata: input.metadata,
            queued: true,
          });
        transcripts.set(input.sessionID, transcript);
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (value: Tool) => void }) => void) => {
        callback({
          add: (value) => {
            registeredTools.set(value.name, value);
            if (value.name === LINKED_NOTE_TOOL) linked = value;
            else if (value.name === 'set_session_target') tool = value;
          },
        });
        return { dispose: async () => void disposed.push('tool') };
      },
      hook: async (_name: string, callback: typeof toolHook) => {
        toolHook = callback;
      },
    },
    command: {
      transform: async (callback: (editor: { add: (value: Command) => void }) => void) => {
        callback({ add: (value) => void commands.set(value.name, value) });
        return { dispose: async () => void disposed.push('command') };
      },
    },
    permission: {
      hook: async (_name: string, callback: typeof permissionHook) => {
        permissionHook = callback;
      },
      assert: async (input: {
        sessionID: string;
        agent?: string;
        action: string;
        resources: readonly string[];
        metadata?: Record<string, unknown>;
      }) => {
        const effect = options.permissionDecision
          ? await options.permissionDecision(input)
          : 'allow';
        const event = {
          sessionID: input.sessionID,
          agent: input.agent,
          action: input.action,
          resources: input.resources,
          metadata: input.metadata,
          effect,
        } as {
          sessionID: string;
          action: string;
          resources: readonly string[];
          effect: string;
          message?: string;
        };
        await permissionHook(event);
        if (event.effect === 'deny')
          throw new Error(event.message ?? `Permission denied for ${input.action}`);
        if (event.effect === 'ask') {
          const reply =
            typeof options.permissionReply === 'function'
              ? await options.permissionReply()
              : options.permissionReply;
          if (reply !== 'allow')
            throw new Error(`Permission request for ${input.action} was not approved`);
        }
      },
    },
    vcs: {
      get: async () => ({
        data: { branch: options.branch ?? { current: 'main', default: 'main' } },
      }),
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const next = events.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      },
    },
  };
  const status = options.status
    ? {
        forges: catalogFor(options.status),
        exec: async () => ({ stdout: '', stderr: 'not in tests', code: 1 }),
        feedback:
          options.feedback ?? (async () => ({ complete: true, viewerID: 'me', comments: [] })),
        reviewRequests:
          options.reviewRequests ??
          (async () => ({ complete: true, viewerID: 'me', newest: 0, requests: [] })),
        details:
          options.details ??
          (async (_request: FeedbackTarget, ids: string[]) =>
            ids.map((id) => ({
              id,
              url: `https://gitlab.com/group/a/-/merge_requests/1#note_${id}`,
              username: 'alice',
              body: `Comment ${id}`,
            }))),
        ...(options.linkedNote ? { linkedNote: options.linkedNote } : {}),
        ...(options.now ? { now: options.now } : {}),
        reviewClaims,
        ...(options.reviewerID ? { reviewerID: options.reviewerID } : {}),
        viewerID: options.viewerID ?? (async () => 'me'),
      }
    : undefined;
  const cleanup = await setupServer(ctx as unknown as Plugin.Context, lookups, status);
  return {
    sessions,
    storage,
    cleanup,
    emitted,
    disposed,
    sourceLookups,
    synthetic,
    passive,
    prompts,
    syntheticStarted: () => syntheticStarted,
    releaseInbox: () => releaseInbox(),
    inboxStarted: () => inboxStarted,
    // Pauses the next session read until the returned function runs.
    holdNextRead: () => {
      let release = () => {};
      nextRead = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
    failNextRead: (error: Error) => void (nextRead = error),
    // Pauses the next storage read of `key` until the returned function runs.
    holdNextGet: (key: string) => {
      let release = () => {};
      heldGets.set(key, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    // Delivers an event to the plugin's subscription.
    emit: (event: unknown) => {
      events.push(event);
      wake();
    },
    renames: () => renames,
    target: (sessionID = 'one') => handlers.target!({ sessionID }),
    monitoringStatus: (sessionID = 'one') =>
      handlers.monitoringStatus!({ sessionID }) as Promise<MonitoringStatus>,
    feedback: () => handlers.feedback!({}) as Promise<InboxState>,
    pauseFeedback: (paused: boolean) => handlers.pauseFeedback!({ paused }),
    acknowledgeFeedback: (id: string) => handlers.acknowledgeFeedback!({ id }),
    summarizeFeedback: (id: string) => handlers.summarizeFeedback!({ id }),
    actOnFeedback: (id: string, retry = false) => handlers.actOnFeedback!({ id, retry }),
    cleanupCandidates: () => handlers.cleanupCandidates!({}) as Promise<CleanupScanResult>,
    cleanupSessions: (
      sessionIDs: string[],
      cleanupOptions?: {
        allowClientArchive?: boolean;
        finalizeArchived?: boolean;
        scanID?: string;
      },
    ) => handlers.cleanupSessions!({ sessionIDs, ...cleanupOptions }) as Promise<CleanupResult>,
    watch: (keys: string[], visible?: string) =>
      handlers.watch!({
        clientID: 'cli',
        keys,
        ...(visible === undefined ? {} : { visible }),
      }) as Promise<{
        enabled: boolean;
        statuses: Record<string, Snapshot>;
      }>,
    refresh: (key = 'one') =>
      handlers.refresh!({ key }) as Promise<{ enabled: boolean; snapshot: Snapshot }>,
    notices: () => emitted.filter((event) => event.name === 'notice').map((event) => event.data),
    lastStatus: (key = 'one') =>
      emitted.findLast(
        (event) => event.name === 'status' && (event.data as { key: string }).key === key,
      )?.data as { snapshot: Snapshot } | undefined,
    set: (input: unknown, sessionID = 'one') => tool.execute(input, { sessionID }),
    commandNames: () => [...commands.keys()],
    // Runs a server command, and returns the answer it wrote to the session.
    runCommand: async (name: string, text = '', sessionID = 'one') => {
      const before = passive.length;
      await commands.get(name)!.execute({ sessionID, prompt: { text }, delivery: 'queue' });
      return passive.slice(before);
    },
    toolOptions: () => tool.options,
    entries: (sessionID = 'one') => Object.fromEntries(entriesOf(sessionID)),
    entryWrites,
    // A user prompt's admission, before any step of its turn.
    admit: (sessionID = 'one') => promptHook({ sessionID }),
    context: async (sessionID = 'one') => {
      const event = { sessionID, system: [] as { type: string; text: string }[] };
      await hook(event);
      return [...event.system.map((part) => part.text), ...entriesOf(sessionID).values()].join(
        '\n',
      );
    },
    system: async (sessionID = 'one') => {
      const event = { sessionID, system: [] as { type: string; text: string }[] };
      await hook(event);
      return event.system.map((part) => part.text).join('\n');
    },
    // A full model request through the context hook, as the agent loop sends
    // it. Its step first delivers the oldest queued message, unless told not to.
    request: async (
      sessionID = 'one',
      deliver = true,
      messages?: unknown[],
      extraTools?: Record<string, unknown>,
    ) => {
      const transcript = transcripts.get(sessionID) ?? [];
      const next = transcript.find((message) => message.queued);
      // Like OpenCode, a delivered message joins the context after everything
      // already in it.
      if (deliver && next) {
        next.queued = false;
        transcript.splice(transcript.indexOf(next), 1);
        transcript.push(next);
      }
      const event = {
        sessionID,
        system: [{ type: 'text', text: 'agent prompt' }],
        messages: (messages ?? [
          new ProviderMessage({ role: 'user', content: [{ type: 'text', text: 'earlier work' }] }),
          new ProviderMessage({ role: 'user', content: [{ type: 'text', text: 'queued notice' }] }),
        ]) as ProviderMessage[],
        // Like OpenCode, every registered tool, the linked-note tool too.
        tools: {
          read: { description: 'Read' },
          bash: { description: 'Run' },
          ...extraTools,
          ...(linked ? { [LINKED_NOTE_TOOL]: { description: 'Linked' } } : {}),
          ...(registeredTools.has('forgekeeper_approval_status')
            ? { forgekeeper_approval_status: { description: 'Approval status' } }
            : {}),
          ...(registeredTools.has('forgekeeper_mark_ready')
            ? { forgekeeper_mark_ready: { description: 'Mark ready' } }
            : {}),
        } as Record<string, unknown>,
        model,
        options: {} as Record<string, unknown>,
      };
      await hook(event as never);
      return event;
    },
    // A compaction request through the compaction hook.
    compact: async (sessionID = 'one', messages: unknown[] = []) => {
      const event = { sessionID, system: [], messages, tools: {}, model, options: {} };
      if (!compactionHook) throw new Error('No compaction hook');
      await compactionHook(event as never);
      return event;
    },
    failContext: (fails: boolean) => void (contextFails = fails),
    // Switches the session to another model, as `provider/model`.
    useModel: (key: string) => {
      const [providerID, ...id] = key.split('/');
      model = { providerID, id: id.join('/') };
    },
    // A user prompt, which ends any summary turn.
    prompt: (sessionID = 'one') => {
      const transcript = transcripts.get(sessionID) ?? [];
      transcript.push({ type: 'user', id: `msg_user_${transcript.length}` });
      transcripts.set(sessionID, transcript);
    },
    // A linked-note tool call, as the model would make it, and its result.
    fetchLinked: (url: unknown, sessionID = 'one') =>
      linked!.execute({ url }, { sessionID }) as Promise<{ content: string }>,
    callTool: (
      name: string,
      input: unknown = {},
      sessionID = 'one',
      extra: {
        agent?: string;
        messageID?: string | undefined;
        id?: string | undefined;
        signal?: AbortSignal;
      } = {},
    ) =>
      registeredTools.get(name)!.execute(input, {
        sessionID,
        messageID: 'msg_assistant_current',
        id: 'call_current',
        ...extra,
      }) as Promise<{
        content: string;
      }>,
    linkedTool: () => linked,
    toolCall: (sessionID = 'one', name = 'bash') =>
      toolHook({ sessionID, tool: name }).then(
        () => undefined,
        (error: Error) => error.message,
      ),
    permission: async (sessionID = 'one', effect = 'allow') => {
      const event = { sessionID, effect } as {
        sessionID: string;
        effect: string;
        message?: string;
      };
      await permissionHook(event);
      return event.effect;
    },
    evaluatePermission: async (sessionID = 'one', effect = 'ask') => {
      const event = { sessionID, effect } as {
        sessionID: string;
        effect: string;
        message?: string;
      };
      await permissionHook(event);
      return event;
    },
  };
}

// A human feedback reader whose comments the test sets. While `hold` is
// set, reads wait for `release()`.
export function feedbackReader() {
  let clock = 100 * SETTLE_TIME;
  let comments: ReviewComment[] = [];
  let gate: Promise<void> | undefined;
  let open = () => {};
  let reads = 0;
  return {
    now: () => clock,
    reads: () => reads,
    advance: (ms: number) => void (clock += ms),
    comment: (id: string): ReviewComment =>
      ({
        id,
        order: Number(id),
        url: `${projectA}#note_${id}`,
        editedAt: clock - SETTLE_TIME,
        resolved: false,
        bot: false,
        authorID: 'someone',
        username: 'alice',
      }) as ReviewComment,
    set: (next: ReviewComment[]) => void (comments = next),
    hold: () => void (gate = new Promise<void>((resolve) => (open = resolve))),
    release: () => open(),
    read: async (): Promise<FeedbackSnapshot> => {
      reads++;
      await gate;
      return { complete: true, viewerID: 'me', comments };
    },
  };
}

export async function watchedFeedback(extra: Partial<Options> = {}) {
  const forge = new StatusForge();
  forge.set('group/a', '1');
  const reader = feedbackReader();
  const app = await harness({ status: forge, feedback: reader.read, now: reader.now, ...extra });
  await app.set({ target: projectA });
  await app.watch(['one'], 'one');
  await settle();
  // The first read records the baseline.
  expect(reader.reads()).toBe(1);
  reader.advance(FETCH_INTERVAL);
  reader.set([reader.comment('7')]);
  return { app, reader, forge };
}

// A session watching its targets, without review feedback.
export async function watchedTargets(urls: string[], extra: Partial<Options> = {}) {
  const forge = extra.status ?? new StatusForge();
  const app = await harness({ ...extra, status: forge });
  await app.set({ targets: urls });
  await app.watch(['one'], 'one');
  await settle();
  return { app, forge };
}
