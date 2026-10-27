import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import type {
  FeedbackSnapshot,
  Forge,
  GitLabMergeRequest,
  ReviewComment,
  ReviewRef,
  ReviewRequest,
} from './forge';
import { kinds, traits, type ForgeCatalog } from './forges';
import { footerSegments } from './format';
import type { RemoteProject } from './git';
import type { TitleLookups } from './lookups';
import { FETCH_INTERVAL, SETTLE_TIME } from './human-review-watch';
import { setupServer } from './server';
import type { Snapshot } from './store';
import { flush, until } from './testing';

type Tool = {
  options?: { codemode?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<unknown>;
};
type Command = {
  name: string;
  execute: (input: {
    sessionID: string;
    prompt: { text: string };
    delivery: string;
  }) => Promise<void>;
};
type Hook = (event: {
  sessionID: string;
  system: { type: string; text: string }[];
}) => Promise<void>;

interface Options {
  babysitScan?: Promise<void>;
  storage?: Map<string, unknown>;
  branch?: { current: string; default: string };
  // What the checkout's forge reports for the branch.
  found?: { branch: string; number?: string };
  sourceBranches?: Map<string, string>;
  failingSession?: boolean;
  pluginOptions?: Record<string, unknown>;
  // Turns PR/MR status on, with this forge for its lookups.
  status?: StatusForge;
  // How many synthetic messages fail before they succeed.
  failingSynthetic?: number;
  // Reads review comments for human feedback, instead of the forge.
  feedback?: (request: ReviewRequest) => Promise<FeedbackSnapshot | undefined>;
  now?: () => number;
  // Synthetic messages wait for `releaseSynthetic()`.
  holdSynthetic?: boolean;
  // Shared with another instance, such as one for another checkout.
  sessions?: Map<
    string,
    { title: string; location: { directory: string }; parentID: string | undefined }
  >;
  // The instance's checkout. Defaults to /repo.
  directory?: string;
  // Branch lookups for titles wait for `releaseBranch()`.
  holdBranch?: boolean;
  // The IDs of the installed skills.
  skills?: string[];
}

// A GitLab forge whose PRs/MRs the test changes between lookups. A gated
// lookup waits for `open()`, then reads the PR/MR as it is at that point.
class StatusForge implements Forge {
  readonly traits = traits('gitlab');
  readonly requests = new Map<string, GitLabMergeRequest>();
  readonly lookups: string[] = [];
  branch: GitLabMergeRequest[] = [];
  private gates: Array<() => void> = [];
  gated = false;

  set(project: string, iid: string, overrides: Partial<GitLabMergeRequest> = {}) {
    this.requests.set(`${project}!${iid}`, {
      forge: 'gitlab',
      iid,
      url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
      state: 'opened',
      ...overrides,
    } as GitLabMergeRequest);
  }

  open() {
    this.gated = false;
    for (const gate of this.gates.splice(0)) gate();
  }

  async findByNumber(projects: readonly RemoteProject[], number: string) {
    const key = `${projects[0].path}!${number}`;
    this.lookups.push(key);
    if (this.gated) await new Promise<void>((resolve) => this.gates.push(resolve));
    return this.requests.get(key);
  }

  async findByBranch() {
    return this.branch;
  }

  async findNumberByBranch() {
    return this.branch[0]?.iid;
  }

  async sourceBranch() {
    return undefined;
  }
}

const catalogFor = (forge: StatusForge): ForgeCatalog => ({
  kinds,
  kind: (host) => (host === 'gitlab.com' ? 'gitlab' : undefined),
  forHost: (host) => (host === 'gitlab.com' ? forge : undefined),
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

const defaultSessions = () =>
  new Map([
    [
      'one',
      {
        title: '[#123, !45] Review changes',
        location: { directory: '/repo' },
        parentID: undefined as string | undefined,
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
const settle = flush;

// Where the server stores a pending automated-review notification.
const pendingRecord = (sessionID: string, url: string) =>
  `status/pending/${encodeURIComponent(sessionID)}/${encodeURIComponent(url)}`;

// Every comment ID that stored feedback records count as announced.
const announcedIn = (storage: Map<string, unknown>) =>
  [...storage]
    .filter(([key]) => key.startsWith('status/feedback/'))
    .flatMap(([, record]) => (record as { announced: string[] }).announced);

async function harness(options: Options = {}) {
  const storage = options.storage ?? new Map<string, unknown>();
  const sessions = options.sessions ?? defaultSessions();
  const directory = options.directory ?? '/repo';
  const sourceLookups: ReviewRef[] = [];
  let releaseBranch = () => {};
  const branchGate = options.holdBranch
    ? new Promise<void>((resolve) => (releaseBranch = resolve))
    : undefined;
  let branchLookups = 0;
  const lookups: TitleLookups = {
    branch: async () => {
      branchLookups++;
      await branchGate;
      return options.found ? { forge: traits('gitlab'), ...options.found } : undefined;
    },
    sourceBranch: async (ref) => {
      sourceLookups.push(ref);
      return options.sourceBranches?.get(ref.iid);
    },
  };
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const prompts: Array<{ sessionID: string; text: string }> = [];
  let hook!: Hook;
  let renames = 0;
  let handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const emitted: Array<{ name: string; data: unknown }> = [];
  const disposed: string[] = [];
  const synthetic: Array<{ sessionID: string; text: string; resume?: boolean }> = [];
  let syntheticFailures = options.failingSynthetic ?? 0;
  let releaseSynthetic = () => {};
  const syntheticGate = options.holdSynthetic
    ? new Promise<void>((resolve) => (releaseSynthetic = resolve))
    : undefined;
  let syntheticStarted = 0;
  // What the next session read does, once: wait for a promise, or fail.
  let nextRead: Promise<void> | Error | undefined;
  // Storage reads of these keys wait, once, for their promise.
  const heldGets = new Map<string, Promise<void>>();
  // Events for the plugin's subscription, which ends when it aborts.
  const events: unknown[] = [];
  let wake = () => {};
  // The session instruction entries, per session.
  const entries = new Map<string, Map<string, string>>();
  const entriesOf = (sessionID: string) => {
    if (!entries.has(sessionID)) entries.set(sessionID, new Map());
    return entries.get(sessionID)!;
  };
  const entryWrites: string[] = [];
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
    options: options.pluginOptions ?? {},
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
      set: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
      remove: async (key: string) => void storage.delete(key),
      scan: async ({ prefix }: { prefix: string }) => {
        if (prefix === 'babysit/') await options.babysitScan;
        return {
          entries: [...storage]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: structuredClone(value) })),
        };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.failingSession) throw new Error('unavailable');
        const next = nextRead;
        nextRead = undefined;
        if (next instanceof Error) throw next;
        await next;
        return sessions.get(sessionID);
      },
      update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
        sessions.get(sessionID)!.title = title;
        renames++;
      },
      hook: async (_name: string, callback: Hook) => {
        hook = callback;
      },
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        syntheticStarted++;
        await syntheticGate;
        if (syntheticFailures > 0) {
          syntheticFailures--;
          throw new Error('session busy');
        }
        synthetic.push(input);
      },
      prompt: async (input: { sessionID: string; text: string }) => void prompts.push(input),
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
          remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
            entryWrites.push(`remove ${key}`);
            entriesOf(sessionID).delete(key);
          },
        },
      },
    },
    tool: {
      transform: async (
        callback: (editor: { add: (value: Tool & { name: string }) => void }) => void,
      ) => {
        callback({ add: (value) => tools.set(value.name, value) });
        return { dispose: async () => void disposed.push('tool') };
      },
    },
    command: {
      transform: async (callback: (editor: { add: (value: Command) => void }) => void) => {
        callback({ add: (value) => commands.set(value.name, value) });
        return { dispose: async () => void disposed.push('command') };
      },
    },
    skill: {
      list: async () => ({ data: (options.skills ?? []).map((id) => ({ id })) }),
    },
    vcs: {
      get: async () => ({
        data: { branch: options.branch ?? { current: 'main', default: 'main' } },
      }),
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
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
        ...(options.feedback ? { feedback: options.feedback } : {}),
        ...(options.now ? { now: options.now } : {}),
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
    syntheticStarted: () => syntheticStarted,
    releaseSynthetic: () => releaseSynthetic(),
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
    branchLookups: () => branchLookups,
    releaseBranch: () => releaseBranch(),
    renames: () => renames,
    target: (sessionID = 'one') => handlers.target!({ sessionID }),
    watch: (keys: string[], visible?: string) =>
      handlers.watch!({
        clientID: 'cli',
        keys,
        ...(visible !== undefined ? { visible } : {}),
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
    set: (input: unknown, sessionID = 'one') =>
      tools.get('set_session_target')!.execute(input, { sessionID }),
    toolOptions: (name: string) => tools.get(name)?.options,
    babysit: (input: unknown, sessionID = 'one') =>
      tools.get('babysit')!.execute(input, { sessionID }) as Promise<{ content: string }>,
    command: (text: string, sessionID = 'one') =>
      commands.get('babysit')!.execute({ sessionID, prompt: { text }, delivery: 'steer' }),
    prompts,
    // What the model reads: the system prompt of one request, then the entries.
    context: async (sessionID = 'one') => {
      const event = { sessionID, system: [] as { type: string; text: string }[] };
      await hook(event);
      return [...event.system.map((part) => part.text), ...entriesOf(sessionID).values()].join(
        '\n',
      );
    },
    // Only the system prompt of one request.
    system: async (sessionID = 'one') => {
      const event = { sessionID, system: [] as { type: string; text: string }[] };
      await hook(event);
      return event.system.map((part) => part.text).join('\n');
    },
    entries: (sessionID = 'one') => Object.fromEntries(entriesOf(sessionID)),
    entryWrites,
  };
}

const mr = 'https://gitlab.com/group/project/-/merge_requests/456';
const nextMr = 'https://gitlab.com/group/project/-/merge_requests/789';
const issue = 'https://gitlab.com/group/project/-/issues/42';

describe('session targets', () => {
  test('registers guidance and replaces branch references even on main', async () => {
    const app = await harness();
    expect(await app.context()).toContain('call set_session_target');
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    expect(await app.context('two')).not.toContain(mr);
    expect(app.sessions.get('two')?.title).toBe('Other session');
    await app.cleanup();
  });

  test('persists the target and owned prefix across plugin reloads', async () => {
    const storage = new Map<string, unknown>();
    const first = await harness({ storage });
    await first.set({ target: mr, issue_url: issue });
    const title = first.sessions.get('one')!.title;
    await first.cleanup();

    const second = await harness({ storage });
    second.sessions.get('one')!.title = title;
    expect(await second.context()).toContain(mr);
    await second.set({ target: nextMr });
    expect(second.sessions.get('one')?.title).toBe('[!789] Review changes');
    await second.set({ target: nextMr });
    expect(second.renames()).toBe(1);
    await second.cleanup();
  });

  test('reset removes the prefix on main and restores automatic context', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    expect(await app.context()).toContain('checked-out branch (automatic)');
    await app.cleanup();
  });

  test('serializes concurrent switches and drops the previous related issue', async () => {
    const app = await harness();
    await Promise.all([app.set({ target: mr, issue_url: issue }), app.set({ target: nextMr })]);
    expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
    await app.cleanup();
  });

  test('rejects invalid targets without changing the current target', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await expect(app.set({ target: '!789' })).rejects.toThrow();
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    await app.cleanup();
  });

  test('targets a newly created MR with its issue', async () => {
    const app = await harness();
    expect(await app.context()).toContain('After you create a PR or MR for the current task');
    await app.set({ target: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123] Review changes');
    await app.set({ target: mr, issue_url: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123, !456] Review changes');
    await app.cleanup();
  });

  test('infers the related issue from the MR source branch', async () => {
    const app = await harness({ sourceBranches: new Map([['456', '321-fix-timeout']]) });
    await app.set({ target: mr });
    expect(app.sourceLookups).toEqual([
      { forge: 'gitlab', host: 'gitlab.com', project: 'group/project', iid: '456' },
    ]);
    expect(app.sessions.get('one')?.title).toBe('[#321, !456] Review changes');
    expect(await app.context()).toContain('"branchIssue":"321"');
    await app.set({ target: nextMr });
    expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
    await app.cleanup();
  });

  test('prefers an explicit issue and skips lookups for issue targets', async () => {
    const app = await harness({ sourceBranches: new Map([['456', '321-fix-timeout']]) });
    await app.set({ target: mr, issue_url: 'https://gitlab.com/group/other/-/issues/42' });
    expect(app.sessions.get('one')?.title).toBe('[#42, !456] Review changes');
    await app.set({ target: 'https://gitlab.com/group/project/-/issues/7' });
    expect(app.sessions.get('one')?.title).toBe('[#7] Review changes');
    expect(app.sourceLookups).toEqual([]);
    await app.cleanup();
  });

  test('exposes the target over RPC and announces changes', async () => {
    const storage = new Map<string, unknown>();
    const app = await harness({ storage });
    expect(await app.target()).toEqual({});
    await app.set({ target: mr, issue_url: issue });
    expect(await app.target()).toEqual({
      url: mr,
      issueUrl: issue,
      targets: [{ url: mr, issueUrl: issue }],
    });
    expect(await app.target('two')).toEqual({});
    await app.set({ target: 'branch' });
    expect(await app.target()).toEqual({});
    expect(app.emitted).toEqual([
      {
        name: 'targetChanged',
        data: {
          sessionID: 'one',
          url: mr,
          issueUrl: issue,
          targets: [{ url: mr, issueUrl: issue }],
        },
      },
      { name: 'targetChanged', data: { sessionID: 'one' } },
    ]);
    await app.cleanup();
    expect(app.disposed).toEqual(['command', 'tool', 'rpc']);

    const reloaded = await harness({ storage });
    await reloaded.set({ target: nextMr });
    expect(await reloaded.target()).toEqual({ url: nextMr, targets: [{ url: nextMr }] });
    await reloaded.cleanup();
  });

  test('keeps the inferred issue of a stored target when adding another', async () => {
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: mr, branchIssue: '123' }], prefix: '[#123, !45]' }],
    ]);
    const app = await harness({ storage, sourceBranches: new Map([['456', '999-other']]) });
    expect(await app.target()).toEqual({ url: mr, targets: [{ url: mr }] });
    await app.set({ target: nextMr, operation: 'add' });
    // The stored target keeps its inferred issue, so only the new one is looked up.
    expect(app.sourceLookups.map((ref) => ref.iid)).toEqual(['789']);
    expect(storage.get('sessions/one')).toEqual({
      targets: [{ url: mr, branchIssue: '123' }, { url: nextMr }],
      prefix: '[!456, !789]',
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    await app.cleanup();
  });

  test('sets, adds, and removes several targets', async () => {
    const app = await harness({
      sourceBranches: new Map([
        ['456', '321-fix-timeout'],
        ['101', '5-other'],
      ]),
    });
    const third = 'https://gitlab.com/group/other/-/merge_requests/101';
    expect(await app.set({ targets: [mr, nextMr] })).toEqual({
      content: `Session targets (2):\n- ${mr}\n- ${nextMr}`,
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    expect(await app.context()).toContain(
      `Current session target: 2 targets: [{"url":"${mr}","branchIssue":"321"},{"url":"${nextMr}"}]`,
    );

    await app.set({ target: third, operation: 'add' });
    expect(app.sessions.get('one')?.title).toBe('[!456, !789, !101] Review changes');
    expect(await app.target()).toEqual({
      url: mr,
      targets: [{ url: mr }, { url: nextMr }, { url: third }],
    });
    expect(app.emitted.at(-1)?.data).toMatchObject({
      sessionID: 'one',
      targets: [{ url: mr }, { url: nextMr }, { url: third }],
    });

    expect(await app.set({ targets: [nextMr, issue], operation: 'remove' })).toEqual({
      content: `Session targets (2):\n- ${mr}\n- ${third}\nNot session targets, so not removed: ${issue}`,
    });
    expect(app.sessions.get('one')?.title).toBe('[!456, !101] Review changes');

    // The remaining target shows its inferred issue again, without another lookup.
    await app.set({ target: third, operation: 'remove' });
    expect(app.sessions.get('one')?.title).toBe('[#321, !456] Review changes');
    expect(app.sourceLookups.map((ref) => ref.iid)).toEqual(['456', '789', '101']);

    expect(await app.set({ target: mr, operation: 'remove' })).toEqual({
      content: 'Session target: checked-out branch.',
    });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    expect(await app.context()).toContain('checked-out branch (automatic)');
    await app.cleanup();
  });

  test('tells the agent to set every target of a task, even ones it has to find', async () => {
    const app = await harness();
    const guidance = await app.context();
    expect(guidance).toContain('with all of their full URLs in targets');
    expect(guidance).toContain(
      'If the user describes them instead of linking them, find them first',
    );
    expect(guidance).toContain('use operation "add" so they are kept');
    expect(guidance).not.toMatch(/weekly|distill/i);
    await app.cleanup();
  });

  test('relates a batch of MRs to one issue and shows it first in the title', async () => {
    const app = await harness();
    await app.set({ targets: [mr, nextMr], issue_url: issue });
    expect(app.storage.get('sessions/one')).toMatchObject({
      targets: [
        { url: mr, issueUrl: issue },
        { url: nextMr, issueUrl: issue },
      ],
    });
    expect(app.sessions.get('one')?.title).toBe('[#42, !456, !789] Review changes');
    await app.cleanup();
  });

  test('rejects invalid batches without changing the targets', async () => {
    const app = await harness();
    await app.set({ targets: [mr, nextMr] });
    await expect(app.set({ targets: [mr, 'branch'] })).rejects.toThrow();
    await expect(app.set({ targets: [mr, issue], issue_url: issue })).rejects.toThrow();
    expect(app.sessions.get('one')?.title).toBe('[!456, !789] Review changes');
    await app.cleanup();
  });

  test('registers its tools as direct tools, since the guidance names them', async () => {
    const app = await harness();
    expect(app.toolOptions('set_session_target')).toEqual({ codemode: false });
    expect(app.toolOptions('babysit')).toEqual({ codemode: false });
    await app.cleanup();
  });

  test('keeps the system prompt constant and puts the target in an instruction entry', async () => {
    const app = await harness();
    expect(await app.system()).toContain('Current session target: checked-out branch (automatic).');
    const stable = await app.system();
    expect(stable).toContain('call set_session_target');
    expect(stable).not.toContain('Current session target');
    expect(app.entries()).toEqual({
      'forgekeeper-session-target': 'Current session target: checked-out branch (automatic).',
    });

    await app.set({ target: mr });
    expect(app.entries()['forgekeeper-session-target']).toContain(mr);
    expect(await app.system()).toBe(stable);
    await app.set({ target: 'branch' });
    expect(app.entries()['forgekeeper-session-target']).toContain('checked-out branch (automatic)');
    await app.cleanup();
  });

  test('writes an instruction entry only when it changed', async () => {
    const app = await harness();
    await app.context();
    await app.context();
    expect(app.entryWrites).toEqual(['put forgekeeper-session-target']);
    await app.set({ target: mr });
    await app.set({ target: mr });
    await app.context();
    expect(app.entryWrites).toEqual([
      'put forgekeeper-session-target',
      'put forgekeeper-session-target',
    ]);
    await app.cleanup();
  });

  test('keeps entries for sessions of this location only', async () => {
    const app = await harness();
    await app.set({ target: mr });
    expect(Object.keys(app.entries('one'))).toEqual(['forgekeeper-session-target']);
    expect(app.entries('two')).toEqual({});
    app.sessions.get('two')!.parentID = 'one';
    await app.context('two');
    expect(app.entries('two')).toEqual({});
    await app.cleanup();
  });

  test('skips child sessions and sessions in another location', async () => {
    const app = await harness();
    app.sessions.get('one')!.parentID = 'parent';
    expect(await app.context()).toBe('');
    expect(app.entryWrites).toEqual([]);
    await expect(app.set({ target: mr })).rejects.toThrow('root session');
    app.sessions.get('two')!.location.directory = '/another/location';
    expect(await app.context('two')).toBe('');
    await expect(app.set({ target: mr }, 'two')).rejects.toThrow('root session');
    await app.cleanup();
  });

  test('keeps targets and titles but serves no status with reviewStatus off', async () => {
    const forge = new StatusForge();
    const app = await harness({ status: forge, pluginOptions: { reviewStatus: false } });
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.watch(['one'], 'one')).toEqual({ enabled: false, statuses: {} });
    expect((await app.refresh()).enabled).toBe(false);
    expect(forge.lookups).toEqual([]);
    await app.cleanup();
  });

  test("never blocks the model request when the session can't be read", async () => {
    const app = await harness({ failingSession: true });
    expect(await app.context()).toBe('');
    await app.cleanup();
  });
});

describe('branch-based naming', () => {
  const feature = { current: '123-fix-login', default: 'main' };

  test("prefixes the branch's issue and PR/MR", async () => {
    const app = await harness({
      branch: feature,
      found: { branch: '123-fix-login', number: '45' },
    });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('[#123, !45] Review changes');
    await app.cleanup();
  });

  test('shows a placeholder until the PR/MR exists', async () => {
    const app = await harness({
      branch: { current: 'tidy-up', default: 'main' },
      found: { branch: 'tidy-up' },
    });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('[tidy-up, !N/A] Review changes');
    await app.cleanup();
  });

  test('leaves the title alone without a forge remote', async () => {
    const app = await harness({ branch: feature });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    await app.cleanup();
  });

  test('skips the default branch', async () => {
    const app = await harness({
      branch: { current: 'trunk', default: 'trunk' },
      found: { branch: 'trunk', number: '1' },
    });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    await app.cleanup();
  });
});

describe('PR/MR status', () => {
  const projectA = 'https://gitlab.com/group/a/-/merge_requests/1';
  const projectB = 'https://gitlab.com/group/b/-/merge_requests/1';
  const quiet = { notifyHumanReviews: false };

  test("serves a shown session's status and publishes changes", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { title: 'Add things' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    const watched = await app.watch(['one'], 'one');
    expect(watched.enabled).toBe(true);
    await settle();
    expect(app.lastStatus()?.snapshot.lookup).toMatchObject({
      kind: 'found',
      explicitTarget: true,
      requests: [{ iid: '1' }],
    });
    expect((await app.watch(['one'], 'one')).statuses.one.lookup).toMatchObject({
      requests: [{ title: 'Add things' }],
    });
    await app.cleanup();
  });

  test('publishes whether the targets include a PR/MR before looking them up', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.watch(['one'], 'one');
    await settle();
    expect(app.lastStatus()?.snapshot.targeted).toBeUndefined();

    forge.gated = true;
    await app.set({ target: projectA });
    await settle();
    expect(app.lastStatus()?.snapshot).toMatchObject({ loading: true, targeted: true });
    expect(footerSegments(app.lastStatus()!.snapshot)).toEqual([]);
    forge.open();
    await settle();

    await app.set({ target: 'https://gitlab.com/group/a/-/issues/2' });
    await settle();
    expect(app.lastStatus()?.snapshot.targeted).toBeUndefined();
    await app.cleanup();
  });

  test('sends only JSON over RPC, even after a lookup clears an error', async () => {
    // JSON has no `undefined`, and the RPC rejects outputs that contain it.
    const hasUndefined = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        Object.values(value).some((entry) => hasUndefined(entry)));
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    const outputs = [
      await app.refresh(),
      await app.watch(['one'], 'one'),
      ...app.emitted.map((event) => event.data),
    ];
    expect(outputs.filter(hasUndefined)).toEqual([]);
    await app.cleanup();
  });

  test('never notifies about a target removed while its lookup was running', async () => {
    // Same MR number in two projects, so the title prefix doesn't change.
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/b', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();

    forge.gated = true;
    const polling = app.refresh();
    await settle();
    await app.set({ target: projectB });
    const changed = app.emitted.length;
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.open();
    await polling;
    await settle();

    expect(app.synthetic).toEqual([]);
    expect(app.lastStatus()?.snapshot.lookup).toMatchObject({ requests: [{ url: projectB }] });
    // The old target's result is discarded, not shown or watched.
    const published = app.emitted.slice(changed).filter((event) => event.name === 'status');
    expect(JSON.stringify(published)).not.toContain('"REVIEWED"');
    await app.cleanup();
  });

  test("tells the session when a target's automated review finishes, with the resume option", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: { ...quiet, resumeSession: false } });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    // Hidden after being shown, but still polled because the review is running.
    await app.watch(['one'], '');
    forge.set('group/a', '1', { duoReviewState: 'REQUESTED_CHANGES' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toMatchObject([{ sessionID: 'one', resume: false }]);
    expect(app.synthetic[0].text).toContain(projectA);
    expect(app.notices()).toMatchObject([
      { sessionID: 'one', title: 'GitLab Duo finished reviewing !1', variant: 'info' },
    ]);
    await app.cleanup();
  });

  test('keeps a failed notification pending and reports it', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet, failingSynthetic: 1 });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toMatchObject([{ sessionID: 'one', variant: 'error' }]);
    expect(app.storage.get(pendingRecord('one', projectA))).toMatchObject({
      sessionID: 'one',
      url: projectA,
    });
    await app.cleanup();
  });

  test('follows the branch instead of a branch prefix the plugin wrote', async () => {
    const forge = new StatusForge();
    forge.set('group/project', '1', { state: 'closed' });
    forge.branch = [
      {
        forge: 'gitlab',
        iid: '2',
        url: 'https://gitlab.com/group/project/-/merge_requests/2',
        state: 'opened',
      } as GitLabMergeRequest,
    ];
    const storage = new Map<string, unknown>([['sessions/two', { prefix: '[!1]' }]]);
    const app = await harness({ status: forge, storage, pluginOptions: quiet });
    app.sessions.get('two')!.title = '[!1] Other session';
    await app.watch(['two'], 'two');
    await settle();
    expect(app.lastStatus('two')?.snapshot.lookup).toMatchObject({ requests: [{ iid: '2' }] });
    expect(forge.lookups).toEqual([]);
    // A reference the user wrote still counts.
    app.sessions.get('two')!.title = '[!1] [!1] Other session';
    expect((await app.refresh('two')).snapshot.lookup).toMatchObject({
      sessionTarget: '!1 (from the session title)',
    });
    await app.cleanup();
  });

  test('stops polling a session that no CLI leases', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.refresh();
    expect(forge.lookups).toHaveLength(1);
    await app.watch([]);
    await app.set({ target: projectB });
    await settle();
    // Nothing leases the session, so the target change doesn't trigger a lookup.
    expect(forge.lookups).toHaveLength(1);
    await app.cleanup();
  });
});

describe('PR/MR status lifecycle', () => {
  const projectA = 'https://gitlab.com/group/a/-/merge_requests/1';
  const projectB = 'https://gitlab.com/group/b/-/merge_requests/1';
  const quiet = { notifyHumanReviews: false };

  // A human feedback reader whose comments the test sets. While `hold` is
  // set, reads wait for `release()`.
  function feedbackReader() {
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

  async function watchedFeedback(extra: Partial<Options> = {}) {
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
    return { app, reader };
  }

  test('tells the session about settled human feedback', async () => {
    const { app } = await watchedFeedback();
    await app.refresh();
    await settle();
    expect(app.synthetic).toMatchObject([{ sessionID: 'one' }]);
    expect(app.synthetic[0].text).toContain(`${projectA}#note_7`);
    await app.cleanup();
  });

  test('never tells a session about feedback read after cleanup started', async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    expect(reader.reads()).toBe(2);
    const stopping = app.cleanup();
    await settle();
    reader.release();
    // Cleanup waits for the running check instead of its 5-second limit.
    await stopping;
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    expect(announcedIn(app.storage)).toEqual([]);
  });

  test('looks up a hidden session after a restart, so its reviews stay watched', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const storage = new Map<string, unknown>([['sessions/one', { targets: [{ url: projectA }] }]]);
    const app = await harness({ status: forge, storage, pluginOptions: quiet });
    // The CLI renews its lease on the hidden session; another one is on screen.
    await app.watch(['one', 'two'], 'two');
    await settle();
    expect(forge.lookups).toContain('group/a!1');
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toMatchObject([{ sessionID: 'one' }]);
    await app.cleanup();
  });

  test("leaves a session that moved to another checkout to that checkout's instance", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet, failingSynthetic: 0 });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    // A CLI that still leases the session here doesn't make this instance watch it.
    expect((await app.refresh()).snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'The session moved to another checkout',
    });
    await settle();
    expect(app.synthetic).toEqual([]);
    expect([...app.storage.keys()].filter((key) => key.startsWith('status/pending/'))).toEqual([]);
    await app.cleanup();
  });

  test('never tells a session that moved while its feedback was read', async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    expect(reader.reads()).toBe(2);
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    reader.release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    // The next lookup leaves the session to its new checkout.
    expect((await app.refresh()).snapshot.lookup).toEqual({
      kind: 'none',
      reason: 'The session moved to another checkout',
    });
    await app.cleanup();
  });

  test('never tells a session that moved while its status was looked up', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.gated = true;
    const polling = app.refresh();
    await settle();
    app.sessions.get('one')!.location.directory = '/repo-worktree';
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.open();
    await polling;
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    await app.cleanup();
  });

  test('stores the outcome of an automated notification that finishes during cleanup', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      [
        pendingRecord('one', projectA),
        { sessionID: 'one', url: projectA, since: Date.now(), retryAt: 0 },
      ],
    ]);
    const app = await harness({
      status: forge,
      storage,
      pluginOptions: quiet,
      holdSynthetic: true,
    });
    await app.watch(['one'], 'one');
    await settle();
    expect(app.syntheticStarted()).toBe(1);
    const stopping = app.cleanup();
    await settle();
    app.releaseSynthetic();
    await stopping;
    expect(app.synthetic).toHaveLength(1);
    // The replacement instance won't send it again.
    expect(app.storage.has(pendingRecord('one', projectA))).toBe(false);
  });

  test('stores the comments of a feedback notification that finishes during cleanup', async () => {
    const { app } = await watchedFeedback({ holdSynthetic: true });
    await app.refresh();
    await settle();
    expect(app.syntheticStarted()).toBe(1);
    const stopping = app.cleanup();
    await settle();
    app.releaseSynthetic();
    await stopping;
    expect(app.synthetic).toHaveLength(1);
    expect(announcedIn(app.storage)).toEqual(['7']);
  });

  // Runs a lookup in which the targets' automated reviews finish, and arms
  // `arm` for the ownership read that the notification starts with.
  async function finishDuringRead(
    app: Awaited<ReturnType<typeof harness>>,
    forge: StatusForge,
    arm: () => void,
  ) {
    forge.gated = true;
    const polling = app.refresh();
    await settle();
    arm();
    forge.open();
    await polling;
    await settle();
  }

  test('never tells a session about a target removed while ownership was read', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    let release = () => {};
    await finishDuringRead(app, forge, () => (release = app.holdNextRead()));
    await app.set({ target: projectB });
    release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(app.notices()).toEqual([]);
    await app.cleanup();
  });

  test('tells a session only about the targets it still has after ownership was read', async () => {
    const projectC = 'https://gitlab.com/group/c/-/merge_requests/1';
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/c', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ targets: [projectA, projectC] });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.set('group/c', '1', { duoReviewState: 'REQUESTED_CHANGES' });
    let release = () => {};
    await finishDuringRead(app, forge, () => (release = app.holdNextRead()));
    await app.set({ targets: [projectA], operation: 'remove' });
    release();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    expect(app.synthetic[0].text).toContain(projectC);
    expect(app.synthetic[0].text).not.toContain(projectA);
    expect(app.notices()).toHaveLength(1);
    await app.cleanup();
  });

  test("keeps an automated notification pending when the session can't be read", async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      [
        pendingRecord('one', projectA),
        { sessionID: 'one', url: projectA, since: Date.now(), retryAt: 0 },
      ],
    ]);
    const app = await harness({ status: forge, storage, pluginOptions: quiet });
    forge.gated = true;
    await app.watch(['one'], 'one');
    await settle();
    app.failNextRead(new Error('database locked'));
    forge.open();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(
      (app.storage.get(pendingRecord('one', projectA)) as { retryAt: number }).retryAt,
    ).toBeGreaterThan(Date.now());
    expect(app.notices()).toMatchObject([{ sessionID: 'one', variant: 'error' }]);
    expect(JSON.stringify(app.notices())).toContain('database locked');
    await app.cleanup();
  });

  test("doesn't count feedback as announced when the session can't be read", async () => {
    const { app, reader } = await watchedFeedback();
    reader.hold();
    await app.refresh();
    await settle();
    app.failNextRead(new Error('database locked'));
    reader.release();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(announcedIn(app.storage)).toEqual([]);
    expect(JSON.stringify(app.notices())).toContain('database locked');
    await app.cleanup();
  });
});

describe('state shared across instances and reloads', () => {
  const projectA = 'https://gitlab.com/group/a/-/merge_requests/1';
  const projectB = 'https://gitlab.com/group/b/-/merge_requests/1';
  const quiet = { notifyHumanReviews: false };

  // Two sessions in two checkouts, whose instances share storage.
  function sharedSessions() {
    const sessions = defaultSessions();
    sessions.set('three', {
      title: 'Elsewhere',
      location: { directory: '/other' },
      parentID: undefined,
    });
    return sessions;
  }

  test("keeps every instance's pending notifications in shared storage", async () => {
    const storage = new Map<string, unknown>();
    const sessions = sharedSessions();
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    forge.set('group/b', '1', { duoReviewState: 'REVIEW_STARTED' });
    const options = { status: forge, storage, sessions, pluginOptions: quiet, failingSynthetic: 1 };
    const here = await harness(options);
    const there = await harness({ ...options, directory: '/other' });
    await here.set({ target: projectA });
    await there.set({ target: projectB }, 'three');
    await here.watch(['one'], 'one');
    await there.watch(['three'], 'three');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED' });
    forge.set('group/b', '1', { duoReviewState: 'REVIEWED' });
    await here.refresh('one');
    await there.refresh('three');
    await settle();
    expect(storage.get(pendingRecord('one', projectA))).toMatchObject({ url: projectA });
    expect(storage.get(pendingRecord('three', projectB))).toMatchObject({ url: projectB });
    await here.cleanup();
    await there.cleanup();
  });

  test("never lets an old instance's title update overwrite a target set after a reload", async () => {
    const storage = new Map<string, unknown>();
    const sessions = defaultSessions();
    const branch = { current: '123-fix-login', default: 'main' };
    const old = await harness({
      storage,
      sessions,
      branch,
      found: { branch: '123-fix-login', number: '45' },
      holdBranch: true,
    });
    old.emit({ type: 'session.execution.succeeded', data: { sessionID: 'one' } });
    await settle();
    expect(old.branchLookups()).toBe(1);
    const stopping = old.cleanup();

    const replacement = await harness({ storage, sessions, branch });
    await replacement.set({ target: mr });
    old.releaseBranch();
    await stopping;
    await settle();
    expect(storage.get('sessions/one')).toMatchObject({ targets: [{ url: mr }] });
    expect(sessions.get('one')?.title).toBe('[!456] Review changes');
    await replacement.cleanup();
  });

  test('never restores old targets from a read that overlapped a target change', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.set('group/b', '1');
    const reader = {
      clock: 100 * SETTLE_TIME,
      gate: undefined as Promise<void> | undefined,
      comments: [] as ReviewComment[],
    };
    let open = () => {};
    const app = await harness({
      status: forge,
      now: () => reader.clock,
      feedback: async () => {
        await reader.gate;
        return { complete: true, viewerID: 'me', comments: reader.comments };
      },
    });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    // A settled human comment on A, whose fetch is still running.
    reader.clock += FETCH_INTERVAL;
    reader.comments = [
      {
        id: '7',
        order: 7,
        url: `${projectA}#note_7`,
        editedAt: reader.clock - SETTLE_TIME,
        resolved: false,
        bot: false,
        authorID: 'someone',
        username: 'alice',
      } as ReviewComment,
    ];
    reader.gate = new Promise<void>((resolve) => (open = resolve));
    await app.refresh();
    await settle();

    // A slow read of the targets returns A after the change to B.
    const release = app.holdNextGet('sessions/one');
    const reading = app.target();
    await settle();
    await app.set({ target: projectB });
    release();
    expect(await reading).toMatchObject({ url: projectA });
    open();
    await settle();
    expect(app.synthetic).toEqual([]);
    await app.cleanup();
  });

  test('never resumes a session for the automated review of a merged MR', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { duoReviewState: 'REVIEW_STARTED' });
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.set({ target: projectA });
    await app.watch(['one'], 'one');
    await settle();
    forge.set('group/a', '1', { duoReviewState: 'REVIEWED', state: 'merged' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    await app.cleanup();
  });
});

describe('babysitting', () => {
  const projectA = 'https://gitlab.com/group/a/-/merge_requests/1';
  const projectB = 'https://gitlab.com/group/b/-/merge_requests/1';
  const quiet = { notifyHumanReviews: false };
  const healthy = {
    headSha: 'aaaa1111',
    pipeline: { status: 'RUNNING', label: 'running' },
    conflicts: false,
    conflictsKnown: true,
    unresolvedThreads: 0,
    threadsComplete: true,
  };
  const babysat = (storage: Map<string, unknown>, sessionID = 'one') =>
    Object.keys(
      (storage.get(`babysit/${sessionID}`) as { items: Record<string, unknown> } | undefined)
        ?.items ?? {},
    );

  test('/babysit adds the MR as a target and starts the agent with built-in instructions', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await settle();
    expect(app.storage.get('sessions/one')).toMatchObject({ targets: [{ url: projectA }] });
    expect(babysat(app.storage)).toEqual([projectA]);
    expect(app.prompts).toHaveLength(1);
    expect(app.prompts[0].text).toContain(projectA);
    expect(app.prompts[0].text).toContain('Do not poll');
    expect(app.prompts[0].text).not.toContain('skill');
    expect(await app.context()).toContain(`This session babysits ${projectA}`);
    await app.cleanup();
  });

  test('keeps a babysitting entry for as long as the session babysits', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await settle();
    expect(app.entries()['forgekeeper-babysitting']).toContain(`This session babysits ${projectA}`);
    expect(app.entries()['forgekeeper-babysitting']).toContain('do not poll');
    expect(await app.system()).not.toContain('babysits');

    await app.command('stop');
    await settle();
    expect(app.entries()).not.toHaveProperty('forgekeeper-babysitting');
    expect(app.entries()).toHaveProperty('forgekeeper-session-target');
    await app.cleanup();
  });

  test('removes the babysitting entry once the MR is ready', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await settle();
    expect(app.entries()).toHaveProperty('forgekeeper-babysitting');

    forge.set('group/a', '1', { ...healthy, pipeline: { status: 'SUCCESS', label: 'passed' } });
    await app.refresh();
    await settle();
    expect(babysat(app.storage)).toEqual([]);
    expect(app.entries()).not.toHaveProperty('forgekeeper-babysitting');
    await app.cleanup();
  });

  test('polls without a CLI and reports each CI failure once per head commit', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await settle();
    expect(forge.lookups.length).toBeGreaterThan(0);
    expect(app.synthetic).toEqual([]);

    forge.set('group/a', '1', { ...healthy, pipeline: { status: 'FAILED', label: 'failed' } });
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    expect(app.synthetic[0].text).toContain('pipeline failed at aaaa1111');

    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);

    // An old failure isn't reported after a push, but the new head's is.
    forge.set('group/a', '1', { ...healthy, headSha: 'bbbb2222' });
    await app.refresh();
    await settle();
    forge.set('group/a', '1', {
      ...healthy,
      headSha: 'bbbb2222',
      pipeline: { status: 'FAILED', label: 'failed' },
    });
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(2);
    expect(app.synthetic[1].text).toContain('bbbb2222');
    await app.cleanup();
  });

  test('stops babysitting an MR once it is ready, and says when everything is done', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await settle();
    forge.set('group/a', '1', {
      ...healthy,
      pipeline: { status: 'SUCCESS', label: 'passed' },
      unresolvedThreads: 1,
    });
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);

    forge.set('group/a', '1', { ...healthy, pipeline: { status: 'SUCCESS', label: 'passed' } });
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    expect(app.synthetic[0].text).toContain('ready for human review');
    expect(app.synthetic[0].text).toContain('Babysitting is finished');
    expect(babysat(app.storage)).toEqual([]);
    await app.cleanup();
  });

  test('reports merge conflicts and closed MRs', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    forge.set('group/b', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(`${projectA} ${projectB}`);
    await settle();
    forge.set('group/a', '1', { ...healthy, conflicts: true });
    forge.set('group/b', '1', { ...healthy, state: 'merged' });
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    expect(app.synthetic[0].text).toContain('merge conflicts');
    expect(app.synthetic[0].text).toContain('it was merged');
    expect(babysat(app.storage)).toEqual([projectA]);
    await app.cleanup();
  });

  test('retries an update that could not be sent', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet, failingSynthetic: 1 });
    await app.command(projectA);
    await settle();
    forge.set('group/a', '1', { ...healthy, pipeline: { status: 'FAILED', label: 'failed' } });
    await app.refresh();
    await settle();
    expect(app.synthetic).toEqual([]);
    expect(JSON.stringify(app.notices())).toContain('Retrying on the next poll');
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    await app.cleanup();
  });

  test('loads the configured skill only when it is installed', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const pluginOptions = { ...quiet, babysitSkill: 'team-babysit' };
    const missing = await harness({ status: forge, pluginOptions });
    await missing.command(projectA);
    expect(missing.prompts[0].text).not.toContain('team-babysit');
    expect(missing.notices()).toMatchObject([
      { message: expect.stringContaining('"team-babysit" is not installed') },
    ]);
    await missing.cleanup();

    const installed = await harness({ status: forge, pluginOptions, skills: ['team-babysit'] });
    await installed.command(projectA);
    expect(installed.prompts[0].text).toContain('Load the `team-babysit` skill');
    await installed.cleanup();
  });

  test('never lets two sessions babysit the same MR', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(projectA);
    await app.command(projectA, 'two');
    expect(app.prompts).toHaveLength(1);
    expect(JSON.stringify(app.notices())).toContain('Another session already babysits');
    expect(babysat(app.storage, 'two')).toEqual([]);
    await app.cleanup();
  });

  test('stops when the target is removed or on /babysit stop', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    forge.set('group/b', '1', healthy);
    const app = await harness({ status: forge, pluginOptions: quiet });
    await app.command(`${projectA} ${projectB}`);
    await app.set({ targets: [projectB], operation: 'remove' });
    expect(babysat(app.storage)).toEqual([projectA]);
    expect((await app.babysit({ operation: 'status' })).content).toContain(projectA);
    await app.command('stop');
    expect(babysat(app.storage)).toEqual([]);
    expect(JSON.stringify(app.notices())).toContain(`Stopped babysitting ${projectA}`);
    await app.cleanup();
  });

  test('keeps babysitting after a reload, without a CLI', async () => {
    const storage = new Map<string, unknown>();
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const first = await harness({ status: forge, storage, pluginOptions: quiet });
    await first.command(projectA);
    await settle();
    await first.cleanup();

    forge.set('group/a', '1', { ...healthy, pipeline: { status: 'FAILED', label: 'failed' } });
    const second = await harness({ status: forge, storage, pluginOptions: quiet });
    await until(() => second.synthetic.length === 1);
    expect(second.synthetic[0].text).toContain('pipeline failed');
    await second.cleanup();
  });

  test('loads babysitting instructions before background restoration finishes', async () => {
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      ['babysit/one', { directory: '/repo', started: 1, items: { [projectA]: {} } }],
    ]);
    let release = () => {};
    const babysitScan = new Promise<void>((resolve) => (release = resolve));
    const forge = new StatusForge();
    forge.set('group/a', '1', healthy);
    const app = await harness({ storage, status: forge, pluginOptions: quiet, babysitScan });
    try {
      expect(await app.context()).toContain(`This session babysits ${projectA}`);
      expect(app.entries()['forgekeeper-babysitting']).toContain(projectA);
    } finally {
      release();
      await settle();
      await app.cleanup();
    }
  });

  test('explains that babysitting needs PR/MR status', async () => {
    const app = await harness({ pluginOptions: { reviewStatus: false } });
    await app.command(projectA);
    expect(app.prompts).toEqual([]);
    expect(app.notices()).toMatchObject([{ variant: 'error' }]);
    await app.cleanup();
  });
});
