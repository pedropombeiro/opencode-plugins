import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec as run } from '../../_shared/src/index.ts';
import type { Exec } from './exec';
import { resolveRepository } from './git';
import { Ineligible } from './review-automation';
import { createReviewClaims, type CheckoutLock, type RecordedWorktree } from './review-claim';
import { linkedMetadata, type DirectorySession } from './linked-session';
import {
  REMOVAL_TIME,
  prepareWorktree,
  sweepWorktrees,
  worktreeMismatch,
  worktreeName,
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

const lock = (batch = 'b1'): CheckoutLock => ({ batch, messageID: `m-${batch}`, url: URL, at: 1 });

// OpenCode's default worktree strategy, which always creates a detached HEAD.
function fixture(sessions: Record<string, DirectorySession[]> = {}) {
  const claims = createReviewClaims(':memory:');
  const created: string[] = [];
  const removed: string[] = [];
  let failCreate = false;
  const deps: WorktreeDependencies = {
    exec,
    claims,
    projectID: 'project',
    ownerDirectory: main,
    worktree: {
      async create({ branch, name }) {
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
    now: () => 1_000,
  };
  return {
    deps,
    claims,
    created,
    removed,
    failNextCreate: () => (failCreate = true),
  };
}

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
    const placement = await prepareWorktree(f.deps, await request(), lock());
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
    const placement = await prepareWorktree(f.deps, await request(), lock());
    expect(placement.directory).toBe(join(root, worktreeName(await request())));
    expect(placement.created).toBe(true);
    // The busy worktree's lock was given back.
    expect(await f.claims.locks.read(busy)).toBeUndefined();
  });

  test('reuses its own worktree for the PR/MR with uncommitted fixes', async () => {
    const f = fixture();
    const first = await prepareWorktree(f.deps, await request(), lock('b1'));
    await f.claims.locks.release(lock('b1'));
    writeFileSync(join(first.directory, 'file'), 'fixed\n');
    const second = await prepareWorktree(f.deps, await request(), lock('b2'));
    expect(second).toEqual(first);
    expect(f.created).toHaveLength(1);
    // Another PR/MR at the same commit doesn't take the changed worktree.
    await f.claims.locks.release(lock('b2'));
    const other = await prepareWorktree(
      f.deps,
      await request({ url: `${URL}0`, iid: '70' }),
      lock('b3'),
    );
    expect(other.directory).not.toBe(first.directory);
  });

  test('one attempt at a time uses a worktree', async () => {
    const existing = join(root, 'existing');
    await git(main, 'worktree', 'add', '--quiet', existing, 'feature');
    const f = fixture();
    expect((await prepareWorktree(f.deps, await request(), lock('b1'))).directory).toBe(existing);
    const second = await prepareWorktree(
      f.deps,
      await request({ url: `${URL}0`, iid: '70' }),
      lock('b2'),
    );
    expect(second.directory).not.toBe(existing);
  });

  test('puts a new worktree on the local branch when it is at the head commit', async () => {
    const f = fixture();
    const placement = await prepareWorktree(f.deps, await request(), lock());
    expect(placement.detached).toBe(false);
    expect(await git(placement.directory, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    expect(await git(main, 'rev-parse', 'feature')).toBe(await head());
  });

  test('creates the local branch, tracking the source branch, when there is none', async () => {
    const sha = await head();
    await git(main, 'branch', '-D', 'feature');
    const f = fixture();
    const placement = await prepareWorktree(f.deps, await request({ headSha: sha }), lock());
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
    const placement = await prepareWorktree(f.deps, await request({ headSha: sha }), lock());
    expect(placement).toMatchObject({ created: true, detached: true, remote: 'origin' });
    expect(await git(placement.directory, 'rev-parse', 'HEAD')).toBe(sha);
    // The other worktree's branch is untouched.
    expect(await git(elsewhere, 'rev-parse', 'HEAD')).not.toBe(sha);
  });

  test('detaches when the local branch is at another commit', async () => {
    const sha = await head();
    await git(main, 'branch', '--force', 'feature', 'main');
    const f = fixture();
    const placement = await prepareWorktree(f.deps, await request({ headSha: sha }), lock());
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
    const placement = await prepareWorktree(f.deps, await request({ headSha: sha }), lock());
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
    const error = await prepareWorktree(f.deps, await request({ headSha: missing }), lock()).catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(Ineligible);
    expect(error.message).toContain('even after fetching feature from origin');
  });

  test('records what a failed creation left, so cleanup can find it', async () => {
    const f = fixture();
    f.failNextCreate();
    await expect(prepareWorktree(f.deps, await request(), lock())).rejects.toThrow(
      'The start command failed',
    );
    const rows = await f.claims.worktrees.list();
    expect(rows).toEqual([
      expect.objectContaining({ key: f.created[0], directory: f.created[0], state: 'ready' }),
    ]);
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
    const placement = await prepareWorktree(f.deps, final, lock());
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
      await f.claims.locks.acquire(directory, lock('b9'));
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
      expect(await f.claims.locks.acquire(directory, lock('b9'))).toBe(true);
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
        taken.push(await f.claims.locks.acquire(directory, lock('b9')));
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
    expect(await result.f.claims.locks.acquire(result.placement.directory, lock('b9'))).toBe(true);
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
});
