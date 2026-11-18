import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exec as run } from '../../_shared/src/index.ts';
import type { Exec } from './exec';
import { resolveRepository } from './git';
import { Ineligible, type AutomationRecord } from './review-automation';
import { createReviewClaims, type CheckoutLock, type RecordedWorktree } from './review-claim';
import { linkedMetadata, type DirectorySession } from './linked-session';
import type { Plugin } from '@opencode/plugin';
import { createLocalEnvironment } from './local-automation-environment';
import type { UpdateExecution } from './automation-environment';
import { PLUGIN_ID } from './plugin-id';
import {
  CREATION_TIME,
  inCheckout,
  REMOVAL_TIME,
  prepareWorktree,
  sweepWorktrees,
  worktreeMismatch,
  type SweepDependencies,
  type WorktreeDependencies,
  type WorktreeRequest,
} from './review-worktree';

const exec: Exec = (file, args, cwd) => run(file, args, { cwd });
const URL = 'https://gitlab.com/team/project/-/merge_requests/7';
const REMOTE = 'https://gitlab.com/team/project.git';

async function git(cwd: string, ...args: string[]) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(() => {
  // Isolates the tests from the developer's Git configuration, such as
  // signing or hooks.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

let root: string;
let main: string;
let origin: string;

// A repository with a `main` commit and a `feature` commit, whose `origin`
// is a GitLab URL that Git rewrites to a local bare repository.
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'forgekeeper-worktree-')));
  origin = join(root, 'origin.git');
  main = join(root, 'main');
  mkdirSync(main);
  await git(root, 'init', '--quiet', '--bare', origin);
  await git(main, 'init', '--quiet', '--initial-branch=main');
  await git(main, 'config', 'user.name', 'Test');
  await git(main, 'config', 'user.email', 'test@example.com');
  await git(main, 'config', `url.${origin}.insteadOf`, REMOTE);
  await git(main, 'remote', 'add', 'origin', REMOTE);
  writeFileSync(join(main, 'file'), 'one\n');
  await git(main, 'add', 'file');
  await git(main, 'commit', '--quiet', '-m', 'one');
  await git(main, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(main, 'file'), 'two\n');
  await git(main, 'commit', '--quiet', '-am', 'two');
  await git(main, 'push', '--quiet', 'origin', 'main', 'feature');
  await git(main, 'switch', '--quiet', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const head = () => git(main, 'rev-parse', 'feature');

async function request(overrides: Partial<WorktreeRequest> = {}): Promise<WorktreeRequest> {
  return {
    url: URL,
    host: 'gitlab.com',
    iid: '7',
    sourceProject: 'team/project',
    sourceBranch: 'feature',
    ...overrides,
    headSha: overrides.headSha ?? (await head()),
  };
}

// The lock of attempt `batch`, whose PR/MR claim is its own.
const lock = (batch = 'b1'): CheckoutLock => ({
  batch,
  messageID: `m-${batch}`,
  url: `${URL}#${batch}`,
  at: 1,
});

// Stores attempt `batch` as running, holding its claim, so it may take
// checkouts. Returns its lock.
async function running(claims: ReturnType<typeof createReviewClaims>, batch = 'b1') {
  const held = lock(batch);
  if (!(await claims.records.read(batch))) {
    const queued: AutomationRecord = {
      batch,
      messageID: held.messageID,
      state: 'queued',
      attempt: 1,
      at: 1,
      item: { id: batch, sessionID: 'one', url: held.url, title: 'Review', links: [], at: 1 },
    };
    await claims.records.save(queued);
    expect(await claims.records.start({ ...queued, state: 'running' }, queued)).toBe(true);
  }
  return held;
}

// OpenCode's default worktree strategy, which always creates a detached HEAD.
function fixture(sessions: Record<string, DirectorySession[]> = {}) {
  const claims = createReviewClaims(':memory:');
  const created: string[] = [];
  const removed: string[] = [];
  let failCreate = false;
  let beforeCreate: (name: string) => Promise<void> | void = () => {};
  const deps: WorktreeDependencies = {
    exec,
    claims,
    projectID: 'project',
    ownerDirectory: main,
    worktree: {
      async create({ branch, name }) {
        await beforeCreate(name!);
        const directory = join(root, name!);
        await git(main, 'worktree', 'add', '--quiet', '--detach', directory, branch ?? 'HEAD');
        created.push(directory);
        if (failCreate) throw new Error('The start command failed');
        return { directory };
      },
      list: async () => created.map((directory) => ({ directory, strategy: 'git' })),
      async remove({ directory, force }) {
        await git(main, 'worktree', 'remove', ...(force ? ['--force'] : []), directory);
        removed.push(directory);
        created.splice(created.indexOf(directory), 1);
      },
    },
    sessions: async (directory) => sessions[directory] ?? [],
    repository: (directory) => resolveRepository(exec, directory, () => true),
    now: () => 1_000,
  };
  return {
    deps,
    claims,
    created,
    removed,
    failNextCreate: () => (failCreate = true),
    onCreate: (hook: typeof beforeCreate) => (beforeCreate = hook),
    lock: (batch?: string) => running(claims, batch),
  };
}

const NEW = /^forgekeeper-project-7-[0-9a-f]{8}$/;

test('the local provider recovers a session created before its ID was saved and cleans up its worktree', async () => {
  const listed: Record<string, DirectorySession[]> = {};
  const f = fixture(listed);
  await f.lock();
  let record = (await f.claims.records.read('b1'))!;
  const execution = {
    stage: 'provisioning' as const,
    provider: 'local-worktree',
    version: 1,
    state: {},
  };
  await f.claims.records.save({ ...record, execution }, record);
  record = (await f.claims.records.read('b1'))!;
  let creates = 0;
  let interrupted = true;
  let closed = false;
  const archived: string[] = [];
  const prompts: unknown[] = [];
  const source = await request();
  const ctx = {
    location: { directory: main, project: { id: 'project' } },
    worktree: f.deps.worktree,
    plugin: { list: async () => ({ data: [{ id: PLUGIN_ID, state: { status: 'active' } }] }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: 'build',
        time: {},
      }),
      list: async () => ({
        data: Object.entries(listed).flatMap(([directory, sessions]) =>
          sessions.map((session) => ({ ...session, location: { directory } })),
        ),
        cursor: {},
      }),
      create: async (value: {
        location: { directory: string };
        metadata: Record<string, unknown>;
      }) => {
        creates++;
        listed[value.location.directory] = [{ id: 'linked', time: {}, metadata: value.metadata }];
        if (interrupted) throw new Error('Interrupted after session creation');
        return { id: 'linked' };
      },
      update: async (value: {
        sessionID: string;
        archived?: boolean;
        metadata?: Record<string, unknown>;
      }) => {
        if (value.archived) archived.push(value.sessionID);
        for (const sessions of Object.values(listed))
          for (const session of sessions)
            if (session.id === value.sessionID && value.metadata) session.metadata = value.metadata;
      },
      prompt: async (value: unknown) => {
        prompts.push(value);
      },
    },
  } as unknown as Plugin.Context;
  const make = () =>
    createLocalEnvironment({
      ctx,
      deps: f.deps,
      signal: new AbortController().signal,
      closing: () => false,
      request: async () => ({ state: closed ? 'closed' : 'opened', ...source }),
      policy: async () => ({ agent: 'build', permissions: [] }),
      exists: async () => true,
      outcome: async () => 'completed',
      startContext: () => ({
        pending: async () => {},
        rules: async () => [],
        check: async () => [],
      }),
      pushNotice: () => 'push',
    });
  const update: UpdateExecution = async (patch) => {
    const next = { ...record, execution: { ...record.execution!, ...patch } as typeof execution };
    if (!(await f.claims.records.save(next, record))) throw new Error('Stale attempt');
    record = next;
    return record;
  };
  try {
    await expect(make().provision(record, update)).rejects.toThrow('Interrupted');
    expect(record.execution!.state.sessionCreating).toBe(true);
    expect(f.created).toHaveLength(1);
    const savedSessions = listed[f.created[0]];
    listed[f.created[0]] = [];
    await expect(make().recover(record)).rejects.toThrow('still unresolved');
    await expect(make().outcome(record)).rejects.toThrow('still unresolved');
    expect(creates).toBe(1);
    listed[f.created[0]] = savedSessions;
    interrupted = false;
    const recovered = make();
    await recovered.recover(record);
    await recovered.provision(record, update);
    expect(creates).toBe(1);
    expect(f.created).toHaveLength(1);
    expect(record.execution!.state).toMatchObject({ sessionID: 'linked', sessionCreating: false });
    const ready = {
      ...record,
      execution: { ...record.execution!, stage: 'submitting' as const, prompt: 'task' },
    };
    await recovered.verify(ready);
    await recovered.submit(ready);
    expect(prompts).toHaveLength(1);
    expect(await recovered.describe(ready, 'started')).toContain('Linked session: linked');
    await f.claims.records.finish({ ...record, state: 'completed' }, record);
    closed = true;
    expect(await recovered.sweep()).toHaveLength(1);
    expect(archived).toEqual(['linked']);
  } finally {
    f.claims.close();
  }
});

const session = (id: string, extra: Partial<DirectorySession> = {}): DirectorySession => ({
  id,
  time: { idle: 5 },
  ...extra,
});

describe('prepareWorktree', () => {
  test('reuses a clean worktree that has the source branch at the head commit', async () => {
    const existing = join(root, 'existing');
    await git(main, 'worktree', 'add', '--quiet', existing, 'feature');
    const f = fixture();
    const placement = await prepareWorktree(f.deps, await request(), await f.lock());
    expect(placement).toEqual({
      directory: existing,
      created: false,
      remote: 'origin',
      detached: false,
    });
    expect(f.created).toEqual([]);
    expect(await f.claims.locks.read(existing)).toEqual(lock());
  });

  test('skips a worktree with changes, or with a busy session, for one it creates', async () => {
    const dirty = join(root, 'dirty');
    await git(main, 'worktree', 'add', '--quiet', '--detach', dirty, 'feature');
    writeFileSync(join(dirty, 'file'), 'mine\n');
    const busy = join(root, 'busy');
    await git(main, 'worktree', 'add', '--quiet', '--detach', busy, 'feature');
    const f = fixture({ [busy]: [session('s1', { time: { idle: 1, busy: 2 } })] });
    const placement = await prepareWorktree(f.deps, await request(), await f.lock());
    expect(basename(placement.directory)).toMatch(NEW);
    expect(placement.created).toBe(true);
    // The busy worktree's lock was given back.
    expect(await f.claims.locks.read(busy)).toBeUndefined();
  });

  test('reuses its own worktree for the PR/MR with uncommitted fixes', async () => {
    const f = fixture();
    const first = await prepareWorktree(f.deps, await request(), await f.lock('b1'));
    await f.claims.locks.release(lock('b1'));
    writeFileSync(join(first.directory, 'file'), 'fixed\n');
    const second = await prepareWorktree(f.deps, await request(), await f.lock('b2'));
    expect(second).toEqual(first);
    expect(f.created).toHaveLength(1);
    // Another PR/MR at the same commit doesn't take the changed worktree.
    await f.claims.locks.release(lock('b2'));
    const other = await prepareWorktree(
      f.deps,
      await request({ url: `${URL}0`, iid: '70' }),
      await f.lock('b3'),
    );
    expect(other.directory).not.toBe(first.directory);
  });

  test('one attempt at a time uses a worktree', async () => {
    const existing = join(root, 'existing');
    await git(main, 'worktree', 'add', '--quiet', existing, 'feature');
    const f = fixture();
    expect((await prepareWorktree(f.deps, await request(), await f.lock('b1'))).directory).toBe(
      existing,
    );
    const second = await prepareWorktree(
      f.deps,
      await request({ url: `${URL}0`, iid: '70' }),
      await f.lock('b2'),
    );
    expect(second.directory).not.toBe(existing);
  });

  test('puts a new worktree on the local branch when it is at the head commit', async () => {
    const f = fixture();
    const placement = await prepareWorktree(f.deps, await request(), await f.lock());
    expect(placement.detached).toBe(false);
    expect(await git(placement.directory, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    expect(await git(main, 'rev-parse', 'feature')).toBe(await head());
  });

  test('creates the local branch, tracking the source branch, when there is none', async () => {
    const sha = await head();
    await git(main, 'branch', '-D', 'feature');
    const f = fixture();
    const placement = await prepareWorktree(
      f.deps,
      await request({ headSha: sha }),
      await f.lock(),
    );
    expect(placement.detached).toBe(false);
    expect(await git(placement.directory, 'rev-parse', 'HEAD')).toBe(sha);
    const lookup = await resolveRepository(exec, placement.directory, () => true);
    expect(lookup.kind === 'repository' && lookup.repository.sourceBranch).toBe('feature');
  });

  test('detaches when the branch is checked out elsewhere at another commit', async () => {
    const sha = await head();
    const elsewhere = join(root, 'elsewhere');
    await git(main, 'worktree', 'add', '--quiet', elsewhere, 'feature');
    writeFileSync(join(elsewhere, 'file'), 'three\n');
    await git(elsewhere, 'commit', '--quiet', '-am', 'three');
    const f = fixture();
    const placement = await prepareWorktree(
      f.deps,
      await request({ headSha: sha }),
      await f.lock(),
    );
    expect(placement).toMatchObject({ created: true, detached: true, remote: 'origin' });
    expect(await git(placement.directory, 'rev-parse', 'HEAD')).toBe(sha);
    // The other worktree's branch is untouched.
    expect(await git(elsewhere, 'rev-parse', 'HEAD')).not.toBe(sha);
  });

  test('detaches when the local branch is at another commit', async () => {
    const sha = await head();
    await git(main, 'branch', '--force', 'feature', 'main');
    const f = fixture();
    const placement = await prepareWorktree(
      f.deps,
      await request({ headSha: sha }),
      await f.lock(),
    );
    expect(placement.detached).toBe(true);
    expect(await git(main, 'rev-parse', 'feature')).toBe(await git(main, 'rev-parse', 'main'));
  });

  test('fetches only the source branch when the head commit is missing', async () => {
    const pusher = join(root, 'pusher');
    await git(root, 'clone', '--quiet', origin, pusher);
    await git(pusher, 'config', 'user.name', 'Test');
    await git(pusher, 'config', 'user.email', 'test@example.com');
    await git(pusher, 'switch', '--quiet', 'feature');
    writeFileSync(join(pusher, 'file'), 'pushed\n');
    await git(pusher, 'commit', '--quiet', '-am', 'pushed');
    await git(pusher, 'push', '--quiet', 'origin', 'feature');
    await git(pusher, 'switch', '--quiet', '-c', 'unrelated');
    await git(pusher, 'push', '--quiet', 'origin', 'unrelated');
    const sha = await git(pusher, 'rev-parse', 'feature');
    const before = await git(main, 'rev-parse', 'feature');

    const f = fixture();
    const placement = await prepareWorktree(
      f.deps,
      await request({ headSha: sha }),
      await f.lock(),
    );
    expect(await git(placement.directory, 'rev-parse', 'HEAD')).toBe(sha);
    // The local branch is behind, so it stays as it was, and so do others.
    expect(placement.detached).toBe(true);
    expect(await git(main, 'rev-parse', 'feature')).toBe(before);
    expect(
      (await run('git', ['rev-parse', '--verify', 'origin/unrelated'], { cwd: main })).code,
    ).not.toBe(0);
  });

  test('skips with a reason when the head commit is still missing after fetching', async () => {
    const f = fixture();
    const missing = 'f'.repeat(40);
    const error = await prepareWorktree(
      f.deps,
      await request({ headSha: missing }),
      await f.lock(),
    ).catch((error) => error);
    expect(error).toBeInstanceOf(Ineligible);
    expect(error.message).toContain('even after fetching feature from origin');
  });

  test('records what a failed creation left, so cleanup can find it', async () => {
    const f = fixture();
    f.failNextCreate();
    await expect(prepareWorktree(f.deps, await request(), await f.lock())).rejects.toThrow(
      'The start command failed',
    );
    const rows = await f.claims.worktrees.list();
    expect(rows).toEqual([
      expect.objectContaining({ key: f.created[0], directory: f.created[0], state: 'ready' }),
    ]);
  });

  test("a failed creation records only its own worktree, never another one's", async () => {
    const f = fixture();
    // Another creation for the PR/MR makes a worktree with the same prefix
    // while this one runs, and already has it recorded.
    const other = join(root, 'forgekeeper-project-7-0badc0de');
    const recorded: RecordedWorktree = {
      key: other,
      directory: other,
      name: basename(other),
      url: `${URL}0`,
      projectID: 'project',
      state: 'ready',
      at: 1,
      creation: '0badc0de',
    };
    f.onCreate(async () => {
      await git(main, 'worktree', 'add', '--quiet', '--detach', other, 'feature');
      f.created.push(other);
      await f.claims.worktrees.save(recorded);
    });
    f.failNextCreate();
    await expect(prepareWorktree(f.deps, await request(), await f.lock())).rejects.toThrow(
      'The start command failed',
    );
    const mine = f.created.find((directory) => directory !== other)!;
    expect(basename(mine)).toMatch(NEW);
    expect(await f.claims.worktrees.read(other)).toEqual(recorded);
    expect(await f.claims.worktrees.list()).toEqual([
      recorded,
      expect.objectContaining({ directory: mine, url: URL, state: 'ready' }),
    ]);
  });

  test('a creation that ends after its attempt did takes no lock, and stays recorded', async () => {
    const f = fixture();
    const held = await f.lock();
    // The owning session is deleted while OpenCode creates the worktree,
    // and another session's recovery ends the attempt.
    f.onCreate(async () => {
      const stored = (await f.claims.records.read(held.batch))!;
      expect(await f.claims.records.finish({ ...stored, state: 'failed' }, stored)).toBe(true);
    });
    await expect(prepareWorktree(f.deps, await request(), held)).rejects.toThrow(
      'The attempt ended',
    );
    expect(await f.claims.locks.read(f.created[0])).toBeUndefined();
    expect(await f.claims.worktrees.list()).toEqual([
      expect.objectContaining({ directory: f.created[0], state: 'ready' }),
    ]);
    // A later attempt can use it.
    const later = await prepareWorktree(f.deps, await request(), await f.lock('b2'));
    expect(later.directory).toBe(f.created[0]);
  });

  test('checks a worktree for changes only once it holds it', async () => {
    const existing = join(root, 'existing');
    await git(main, 'worktree', 'add', '--quiet', '--detach', existing, 'feature');
    const f = fixture();
    const acquire = f.claims.locks.acquire;
    // Another attempt that held the clean worktree left changes there, and
    // let it go, just before this attempt takes it.
    f.claims.locks.acquire = async (directory, holder) => {
      if (directory === existing) writeFileSync(join(existing, 'file'), 'theirs\n');
      return acquire(directory, holder);
    };
    const placement = await prepareWorktree(f.deps, await request(), await f.lock());
    expect(placement.directory).not.toBe(existing);
    expect(await f.claims.locks.read(existing)).toBeUndefined();
  });

  describe('on a fork, whose local branch of the same name pushes upstream', () => {
    const FORK = 'https://gitlab.com/fork/project.git';
    const fromFork = () => request({ sourceProject: 'fork/project' });

    beforeEach(async () => {
      const fork = join(root, 'fork.git');
      await git(root, 'init', '--quiet', '--bare', fork);
      await git(main, 'config', `url.${fork}.insteadOf`, FORK);
      await git(main, 'remote', 'add', 'fork', FORK);
      await git(main, 'push', '--quiet', 'fork', 'feature');
      await git(main, 'fetch', '--quiet', 'origin');
      await git(main, 'branch', '--quiet', '--set-upstream-to=origin/feature', 'feature');
    });

    test('a new worktree stays detached, pushing to the fork', async () => {
      const f = fixture();
      const placement = await prepareWorktree(f.deps, await fromFork(), await f.lock());
      expect(placement).toMatchObject({ created: true, detached: true, remote: 'fork' });
      const symbolic = await run('git', ['symbolic-ref', '-q', 'HEAD'], {
        cwd: placement.directory,
      });
      expect(symbolic.code).not.toBe(0);
      expect(
        await worktreeMismatch(exec, f.deps.repository, placement.directory, await fromFork()),
      ).toBeUndefined();
    });

    test('a worktree on that branch is skipped', async () => {
      const existing = join(root, 'existing');
      await git(main, 'worktree', 'add', '--quiet', existing, 'feature');
      const f = fixture();
      const placement = await prepareWorktree(f.deps, await fromFork(), await f.lock());
      expect(placement.directory).not.toBe(existing);
      expect(placement).toMatchObject({ detached: true, remote: 'fork' });
      expect(await f.claims.locks.read(existing)).toBeUndefined();
    });
  });
});

describe('inCheckout', () => {
  test('counts the checkout and below it, but no sibling or nested checkout', () => {
    const checkouts = ['/repo', '/repo/.worktrees/a', '/repo-other'];
    expect(inCheckout('/repo', '/repo', checkouts)).toBe(true);
    expect(inCheckout('/repo/packages/app', '/repo', checkouts)).toBe(true);
    expect(inCheckout('/repo-other', '/repo', checkouts)).toBe(false);
    expect(inCheckout('/repo/.worktrees/a/src', '/repo', checkouts)).toBe(false);
    expect(inCheckout('/repo/.worktrees/a/src', '/repo/.worktrees/a', checkouts)).toBe(true);
    // Without the repository's checkouts, a nested one counts too.
    expect(inCheckout('/repo/.worktrees/a/src', '/repo', [])).toBe(true);
  });

  test('counts a session reached through a symbolic link', () => {
    const checkout = join(root, 'main');
    const alias = join(root, 'alias');
    symlinkSync(checkout, alias);
    mkdirSync(join(checkout, 'nested'));
    expect(inCheckout(join(alias, 'nested'), checkout, [checkout])).toBe(true);
    expect(inCheckout(join(checkout, 'nested'), alias, [checkout])).toBe(true);
  });
});

describe('worktreeMismatch', () => {
  const repository = (directory: string) => resolveRepository(exec, directory, () => true);

  test('accepts the source branch or a detached HEAD at the head commit', async () => {
    const onBranch = join(root, 'on-branch');
    await git(main, 'worktree', 'add', '--quiet', onBranch, 'feature');
    expect(await worktreeMismatch(exec, repository, onBranch, await request())).toBeUndefined();
    const detached = join(root, 'detached');
    await git(main, 'worktree', 'add', '--quiet', '--detach', detached, 'feature');
    expect(await worktreeMismatch(exec, repository, detached, await request())).toBeUndefined();
  });

  test('rejects another commit, branch, or source project', async () => {
    const original = await request();
    const other = join(root, 'other');
    await git(main, 'worktree', 'add', '--quiet', other, 'feature');
    writeFileSync(join(other, 'file'), 'moved\n');
    await git(other, 'commit', '--quiet', '-am', 'moved');
    expect(await worktreeMismatch(exec, repository, other, original)).toContain('head commit');
    await git(other, 'reset', '--quiet', '--hard', original.headSha);
    await git(main, 'switch', '--quiet', '-c', 'renamed', 'feature');
    expect(
      await worktreeMismatch(exec, repository, main, await request({ sourceBranch: 'elsewhere' })),
    ).toContain('source branch');
    const detached = join(root, 'detached');
    await git(main, 'worktree', 'add', '--quiet', '--detach', detached, 'feature');
    expect(
      await worktreeMismatch(
        exec,
        repository,
        detached,
        await request({ sourceProject: 'fork/project' }),
      ),
    ).toContain('fork/project');
  });
});

describe('sweepWorktrees', () => {
  async function swept(
    setup: (directory: string, f: ReturnType<typeof fixture>) => Promise<void> | void,
    state = 'merged',
    sessions: (
      directory: string,
      f: ReturnType<typeof fixture>,
    ) => DirectorySession[] | Promise<DirectorySession[]> = () => [],
  ) {
    const f = fixture();
    const final = await request();
    const placement = await prepareWorktree(f.deps, final, await f.lock());
    await f.claims.locks.release(lock());
    await setup(placement.directory, f);
    const archived: string[] = [];
    const deps: SweepDependencies = {
      ...f.deps,
      sessions: async (directory) => sessions(directory, f),
      request: async () => ({ state, headSha: final.headSha }),
      archive: async (id) => void archived.push(id),
    };
    return { removed: await sweepWorktrees(deps), placement, f, archived };
  }

  test('removes a clean worktree it created once the PR/MR merged', async () => {
    const linked = session('s2', { metadata: linkedMetadata('s1', 'b', 's2') });
    const result = await swept(
      () => {},
      'merged',
      () => [linked],
    );
    expect(result.removed).toEqual([result.placement.directory]);
    expect(await result.f.claims.worktrees.list()).toEqual([]);
    expect(result.archived).toEqual(['s2']);
  });

  test('keeps it while the PR/MR is open', async () => {
    expect((await swept(() => {}, 'opened')).removed).toEqual([]);
  });

  test('keeps it with uncommitted changes', async () => {
    const result = await swept((directory) => writeFileSync(join(directory, 'file'), 'x\n'));
    expect(result.removed).toEqual([]);
  });

  test('keeps it with commits the PR/MR never had', async () => {
    const result = await swept(async (directory) => {
      writeFileSync(join(directory, 'file'), 'local\n');
      await git(directory, 'commit', '--quiet', '-am', 'local');
    });
    expect(result.removed).toEqual([]);
  });

  test('keeps it while an attempt holds it, or another session uses it', async () => {
    const held = await swept(async (directory, f) => {
      await f.claims.locks.acquire(directory, await f.lock('b9'));
    });
    expect(held.removed).toEqual([]);
    const used = await swept(
      () => {},
      'merged',
      () => [session('mine')],
    );
    expect(used.removed).toEqual([]);
  });

  test('keeps it while an attempt holds it', async () => {
    const result = await swept(async (directory, f) => {
      expect(await f.claims.locks.acquire(directory, await f.lock('b9'))).toBe(true);
    });
    expect(result.removed).toEqual([]);
    expect(result.f.removed).toEqual([]);
    expect(await result.f.claims.locks.read(result.placement.directory)).toEqual(lock('b9'));
  });

  test('no attempt can take it while cleanup checks it', async () => {
    const taken: boolean[] = [];
    const result = await swept(
      () => {},
      'merged',
      async (directory, f) => {
        // Another PR/MR at the same commit tries to reuse the worktree.
        taken.push(await f.claims.locks.acquire(directory, await f.lock('b9')));
        return [];
      },
    );
    expect(taken).toEqual([false]);
    expect(result.removed).toEqual([result.placement.directory]);
    expect(await result.f.claims.locks.read(result.placement.directory)).toBeUndefined();
  });

  const linkedRoot = session('s2', { metadata: linkedMetadata('s1', 'b', 's2') });

  test('keeps it while a subagent there is busy', async () => {
    const result = await swept(
      () => {},
      'merged',
      () => [linkedRoot, session('sub', { parentID: 's2', time: { idle: 1, busy: 2 } })],
    );
    expect(result.removed).toEqual([]);
  });

  test("keeps it while it has a subagent of a session that isn't linked", async () => {
    const result = await swept(
      () => {},
      'merged',
      () => [linkedRoot, session('sub', { parentID: 'elsewhere' })],
    );
    expect(result.removed).toEqual([]);
  });

  test('removes it with idle subagents of its linked session, archiving only the linked one', async () => {
    const result = await swept(
      () => {},
      'merged',
      () => [linkedRoot, session('sub', { parentID: 's2' })],
    );
    expect(result.removed).toEqual([result.placement.directory]);
    expect(result.archived).toEqual(['s2']);
  });

  test('takes over a removal that a crash left, and makes the worktree reusable when it no longer qualifies', async () => {
    const result = await swept(async (directory, f) => {
      const [row] = await f.claims.worktrees.list();
      expect(row.state).toBe('ready');
      expect(await f.claims.worktrees.reserveRemoval(row as RecordedWorktree, 1)).toBeDefined();
      // The removal stopped there, and the worktree changed since.
      writeFileSync(join(directory, 'file'), 'changed\n');
      f.deps.now = () => 1 + REMOVAL_TIME;
    });
    expect(result.removed).toEqual([]);
    expect(await result.f.claims.worktrees.list()).toEqual([
      expect.objectContaining({ state: 'ready' }),
    ]);
    expect(
      await result.f.claims.locks.acquire(result.placement.directory, await result.f.lock('b9')),
    ).toBe(true);
  });

  test('never removes a worktree it did not create', async () => {
    const existing = join(root, 'existing');
    await git(main, 'worktree', 'add', '--quiet', existing, 'feature');
    const f = fixture();
    const removed = await sweepWorktrees({
      ...f.deps,
      request: async () => ({ state: 'merged', headSha: await head() }),
      archive: async () => {},
    });
    expect(removed).toEqual([]);
    expect(f.removed).toEqual([]);
  });

  test('records what an interrupted creation left only under its own name', async () => {
    const f = fixture();
    const add = async (name: string) => {
      const directory = join(root, name);
      await git(main, 'worktree', 'add', '--quiet', '--detach', directory, 'feature');
      f.created.push(directory);
      return directory;
    };
    const intent = (name: string, creation?: string) => ({
      key: `intent:${name}`,
      name,
      url: URL,
      projectID: 'project',
      state: 'creating' as const,
      at: 1,
      ...(creation ? { creation } : {}),
    });
    const left = await add('forgekeeper-project-7-abcd1234');
    // Another worktree with the PR/MR's prefix, and one an earlier version
    // named without a creation's random part.
    await add('forgekeeper-project-7-feedf00d');
    await add('forgekeeper-project-7');
    await f.claims.worktrees.save(intent('forgekeeper-project-7-abcd1234', 'abcd1234'));
    await f.claims.worktrees.save(intent('forgekeeper-project-7'));
    f.deps.now = () => 1 + CREATION_TIME;
    await sweepWorktrees({
      ...f.deps,
      request: async () => ({ state: 'opened' }),
      archive: async () => {},
    });
    expect(await f.claims.worktrees.list()).toEqual([
      expect.objectContaining({ directory: left, state: 'ready', creation: 'abcd1234' }),
    ]);
  });
});
