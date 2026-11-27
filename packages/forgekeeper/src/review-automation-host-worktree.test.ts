import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import { INVESTIGATION_QUIET_TIME } from './job-investigation';
import { linkedMetadata, presenceKey } from './linked-session';
import { extractTurnReport, formatUncommittedChanges } from './local-automation-environment';
import type { AutomationRule } from './options';
import { Ineligible, type AutomationRecord, type LinkedRecord } from './review-automation';
import {
  LINKED_INSTRUCTIONS,
  ownerPolicy,
  pushNotice,
  storedPreparation,
} from './review-automation-host';
import {
  head,
  hostBatch as batch,
  hostFixture,
  hostReview as review,
  hostRule as rule,
  hostUrl as url,
  linkedAttempt,
  linkedSessions,
  message,
  messageID,
  ownerReady,
  record,
  type HostFixtureOptions,
  type Message,
} from './review-automation-harness';
import { SUMMARY_KIND } from './review-summary';
import { createSummaryDelivery } from './summary-delivery';

describe('worktree automation', () => {
  test('a checkout elsewhere runs in a worktree only when every rule opts in', async () => {
    const opted = { ...rule, execution: 'environment' as const };
    const cases: Array<[AutomationRule[], string]> = [
      [[opted], 'environment'],
      [[opted, { ...rule, reviewers: ['bot'] }], 'skip'],
      [[rule], 'skip'],
    ];
    for (const [rules, expected] of cases) {
      const f = hostFixture({ rules, checkout: 'main' });
      const result = await f.host.validate(review, true).then(
        ({ placement }) => placement,
        (error) => (error instanceof Ineligible ? 'skip' : error),
      );
      expect(result).toBe(expected);
      f.close();
    }
    // A matching checkout runs in the owning session, whatever the rules say.
    const matching = hostFixture({ rules: [opted] });
    expect((await matching.host.validate(review, true)).placement).toBe('session');
    matching.close();
  });

  test('linked sessions never count as owners', async () => {
    const f = hostFixture({
      sessions: {
        linked: {
          id: 'linked',
          time: {},
          location: { directory: '/worktree' },
          metadata: linkedMetadata('one', 'batch', 'linked'),
        },
      },
    });
    expect(await f.host.associations(url)).toEqual(['one']);
    f.close();
  });

  test("checks a linked session's first request against the owner's instance, inbox, and targets", async () => {
    const attempt = linkedAttempt();
    const f = hostFixture({ sessions: linkedSessions });
    await f.claims.records.save(attempt);
    // The update isn't in the owner's inbox.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      'canceled before the coding turn',
    );
    f.storage[`feedback-inbox/${encodeURIComponent('/owner')}`] = {
      items: [review],
      paused: false,
    };
    // The owner no longer targets the PR/MR.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      'canceled before the coding turn',
    );
    f.storage['sessions/one'] = { targets: [{ url }] };
    // The owner's instance isn't running, so its rules can't be read.
    await expect(f.authorizeStart(attempt, 'gitlab/model')).rejects.toThrow(
      "Forgekeeper isn't running in /owner",
    );
    // A turn that moved out of its worktree never starts.
    await expect(
      f.authorizeStart(
        {
          ...attempt,
          execution: {
            ...attempt.execution!,
            state: { ...attempt.execution.state, directory: '/elsewhere' },
          },
        },
        'gitlab/model',
      ),
    ).rejects.toThrow("isn't in its worktree anymore");
    expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
    f.close();
  });

  describe("a linked investigation's first request", () => {
    const at = 10_000_000;
    const failure = { ...review, id: 'f1', kind: 'ci-failed' as const, pipeline: 'p1', at };
    const job = {
      on: 'job-failed' as const,
      host: 'gitlab.com',
      projects: ['group/project'],
      action: 'investigate' as const,
    };
    // A service account's MR, covered only by the rule that lists it.
    const listing: AutomationRule = {
      ...job,
      authors: ['service-bot'],
      allowedModels: ['gitlab/strong'],
      execution: 'environment',
    };
    function investigation(rules: AutomationRule[], extra: Partial<HostFixtureOptions> = {}) {
      let clock = at;
      const f = hostFixture({
        sessions: linkedSessions,
        viewer: 'me',
        accounts: { 'service-bot': 'svc' },
        request: {
          authorID: 'svc',
          pipeline: {
            id: 'p1',
            status: 'RUNNING',
            running: true,
            failedJobs: [{ id: 'j1', name: 'rspec', stage: 'test' }],
            failedJobsComplete: true,
          },
        },
        now: () => clock,
        storage: ownerReady(rules, at, failure),
        ...extra,
      });
      return { f, advance: (ms: number) => (clock += ms), now: () => clock };
    }

    test("runs under the owner's rules for the MR's author, not every rule", async () => {
      const done = { ...failure, at: at - INVESTIGATION_QUIET_TIME };
      const { f } = investigation([listing, job], {
        storage: ownerReady([listing, job], at, done),
      });
      const attempt = linkedAttempt(done);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/any')).rejects.toThrow(
        'needs one of these models: gitlab/strong',
      );
      expect(f.synthetic).toEqual([]);
      const started = await f.authorizeStart(attempt, 'gitlab/strong');
      expect(started).toMatchObject({ startedAt: at, models: ['gitlab/strong'] });
      expect(await f.claims.records.read(batch)).toEqual(started);
      expect(f.synthetic).toHaveLength(1);
      expect(f.synthetic[0]).toMatchObject({
        sessionID: 'one',
        description: 'Forgekeeper: investigating failed jobs for !1',
        metadata: { forgekeeper: SUMMARY_KIND },
        resume: true,
      });
      f.close();
    });

    test("refuses once the owner's rules no longer let it run in a worktree", async () => {
      const done = { ...failure, at: at - INVESTIGATION_QUIET_TIME };
      const inSession: AutomationRule = { ...listing, execution: 'session' };
      const { f } = investigation([inSession], {
        storage: ownerReady([inSession], at, done),
      });
      const attempt = linkedAttempt(done);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        'no longer let this turn run in an environment',
      );
      f.close();
    });

    test('waits out the quiet time again after a later failure', async () => {
      let sleeps = 0;
      const later = { ...failure, id: 'f2', at: at + 60_000 };
      const context: { f?: ReturnType<typeof hostFixture>; advance?: (ms: number) => number } = {};
      const { f, advance, now } = investigation([listing], {
        sleep: async (ms) => {
          sleeps++;
          const currentAt = context.advance!(ms);
          // The owner's instance keeps announcing itself.
          context.f!.storage[presenceKey('/owner')] = {
            at: currentAt,
            instance: 'owner',
            rules: [listing],
          };
          // A failure during the wait replaces the batch's update.
          if (sleeps === 1) {
            const stored = (await context.f!.claims.records.read(batch))!;
            await context.f!.claims.records.save({ ...stored, item: later }, stored);
            context.f!.storage[`feedback-inbox/${encodeURIComponent('/owner')}`] = {
              items: [later],
              paused: false,
            };
          }
        },
      });
      Object.assign(context, { f, advance });
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await f.authorizeStart(attempt, 'gitlab/strong');
      const started = (await f.claims.records.read(batch))!;
      expect(started.item.id).toBe('f2');
      expect(started.startedAt).toBe(now());
      expect(now() - later.at).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
      f.close();
    });

    test('refuses once another session started in the worktree during the wait', async () => {
      const pages: Array<Array<Record<string, unknown>>> = [[]];
      const context: { f?: ReturnType<typeof hostFixture>; advance?: (ms: number) => number } = {};
      const { f, advance } = investigation([listing], {
        pages,
        sleep: async (ms) => {
          const currentAt = context.advance!(ms);
          context.f!.storage[presenceKey('/owner')] = {
            at: currentAt,
            instance: 'owner',
            rules: [listing],
          };
          // Someone starts a task in a package of the worktree.
          pages[0] = [
            { id: 'other', time: { idle: 1, busy: 2 }, location: { directory: '/repo/app' } },
          ];
        },
      });
      Object.assign(context, { f, advance });
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        'Another session is running in /repo',
      );
      expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
      f.close();
    });

    test("reads the owner's rules after the wait, and refuses once its instance stopped", async () => {
      const context: { advance?: (ms: number) => number } = {};
      // The owner's instance stops announcing itself during the wait.
      const { f, advance } = investigation([listing], {
        sleep: async (ms) => void context.advance!(ms),
      });
      context.advance = advance;
      const attempt = linkedAttempt(failure);
      await f.claims.records.save(attempt);
      await expect(f.authorizeStart(attempt, 'gitlab/strong')).rejects.toThrow(
        "Forgekeeper isn't running in /owner",
      );
      expect((await f.claims.records.read(batch))?.startedAt).toBeUndefined();
      f.close();
    });
  });

  test('a service account MR runs in a worktree only when the rules covering its author opt in', async () => {
    const listing = { ...rule, authors: ['service-bot'], execution: 'environment' as const };
    const other = { ...rule, reviewers: ['bot'] };
    const service = { viewer: 'me', accounts: { 'service-bot': 'svc' }, checkout: 'main' };
    const covered = hostFixture({
      ...service,
      rules: [listing, other],
      request: { authorID: 'svc' },
    });
    // The rule without `checkout` doesn't cover the MR's author, so it doesn't count.
    expect(await covered.host.validate(review, true)).toEqual({
      placement: 'environment',
      rules: [listing],
    });
    covered.close();
    const inSession = { ...listing, execution: 'session' as const };
    const kept = hostFixture({
      ...service,
      rules: [inSession, other],
      request: { authorID: 'svc' },
    });
    await expect(kept.host.validate(review, true)).rejects.toThrow('The checkout does not match');
    kept.close();
  });

  test("a worktree whose instance hasn't started yet is checked by the turn's first request", async () => {
    // Listing plugins doesn't start an instance, so only the prompt can: no
    // presence is waited for before submitting.
    const f = hostFixture({ sessions: linkedSessions });
    expect(await f.host.environments!.providers[0].verify(linkedAttempt())).toBeUndefined();
    f.close();
  });

  test('a busy subagent, or a busy session on a later page, keeps the worktree from the turn', async () => {
    const at = Date.now();
    const verify = async (pages: Array<Array<Record<string, unknown>>>) => {
      const f = hostFixture({
        sessions: linkedSessions,
        pages,
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return { result, pages: f.listed.length };
    };
    const busy = { time: { idle: 1, busy: 2 } };
    expect(await verify([[{ id: 'child', parentID: 'other', ...busy }]])).toEqual({
      result: 'Another session is running in /repo',
      pages: 1,
    });
    expect(await verify([[{ id: 'idle', time: { idle: 2 } }], [{ id: 'late', ...busy }]])).toEqual({
      result: 'Another session is running in /repo',
      pages: 2,
    });
    expect(await verify([[{ id: 'idle', time: { idle: 2 } }]])).toEqual({
      result: 'free',
      pages: 1,
    });
  });

  test("a busy session below the worktree's directory keeps the worktree from the turn", async () => {
    const at = Date.now();
    const busy = { time: { idle: 1, busy: 2 } };
    const verify = async (directory: string) => {
      const f = hostFixture({
        sessions: linkedSessions,
        pages: [[{ id: 'nested', ...busy, location: { directory } }]],
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return { result, listed: f.listed[0] };
    };
    // OpenCode lists a directory's sessions without those below it, so the
    // project's are listed.
    expect(await verify('/repo/packages/app')).toEqual({
      result: 'Another session is running in /repo',
      listed: { project: 'project', archived: false, limit: 200 },
    });
    expect((await verify('/repo-other')).result).toBe('free');
  });

  test("a borrowed worktree with someone else's changes keeps the turn from it", async () => {
    const at = Date.now();
    const verify = async (owned: boolean) => {
      const f = hostFixture({
        sessions: linkedSessions,
        status: ' M file',
        storage: { [presenceKey('/repo')]: { at, instance: 'here', rules: [] } },
      });
      if (owned)
        await f.claims.worktrees.save({
          key: '/repo',
          directory: '/repo',
          name: 'forgekeeper-project-1-abcd1234',
          url,
          projectID: 'project',
          state: 'ready',
          at: 1,
        });
      const result = await f.host.environments!.providers[0].verify(linkedAttempt()).then(
        () => 'free',
        (error: Error) => error.message,
      );
      f.close();
      return result;
    };
    expect(await verify(false)).toBe("/repo has uncommitted changes that this task didn't make");
    // Forgekeeper's own worktree for the PR/MR keeps an earlier batch's fixes.
    expect(await verify(true)).toBe('free');
  });

  test("the linked session gets the owner's agent with its rules in the owning checkout", async () => {
    const asked: unknown[] = [];
    const ctx = {
      agent: {
        get: async (input: unknown) => {
          asked.push(input);
          return {
            data: { id: 'build', permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] },
          };
        },
      },
    } as unknown as Plugin.Context;
    const owner = {
      id: 'one',
      agent: 'build',
      location: { directory: '/owner' },
      permissions: [{ action: 'edit', resource: 'src/*', effect: 'allow' }],
    } as unknown as Parameters<typeof ownerPolicy>[1];
    // The owner's own rules follow its agent's, so they still win where
    // they match.
    expect(await ownerPolicy(ctx, owner)).toEqual({
      agent: 'build',
      permissions: [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'edit', resource: 'src/*', effect: 'allow' },
      ],
    });
    expect(asked).toEqual([{ agentID: 'build', location: { directory: '/owner' } }]);
    // Without an agent of the owner's own, its rules can't be read for certain.
    const implicit = { ...owner, agent: undefined } as unknown as typeof owner;
    await expect(ownerPolicy(ctx, implicit)).rejects.toBeInstanceOf(Ineligible);
  });

  test('the push command for a detached worktree reads every branch name literally', async () => {
    for (const branch of ['feature;pwd', 'a$(id)b', "it's", 'tick`id`', 'x```y']) {
      const notice = pushNotice(branch, 'my fork');
      const fence = notice.match(/(`{3,})sh\n([\s\S]*?)\n\1$/);
      expect(fence).not.toBeNull();
      const result = Bun.spawnSync(['sh', '-c', `git() { printf '%s\\n' "$@"; }\n${fence![2]}`]);
      expect(result.stdout.toString()).toBe(`push\nmy fork\nHEAD:refs/heads/${branch}\n`);
    }
  });

  test('keeps watching a linked attempt whose owner was deleted', async () => {
    const f = hostFixture({ sessions: { one: undefined as never } });
    delete f.sessions.one;
    const attempt = {
      ...linkedAttempt(),
      execution: { ...linkedAttempt().execution!, ownerDirectory: '/repo' },
    };
    await f.claims.records.save(attempt);
    expect(await f.restorable()).toEqual([attempt]);
    f.close();
  });

  test("puts the task in place of the placeholder only in its linked session's started turn", async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const request = (sessionID: string) => ({
      sessionID,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Task\n\n[forgekeeper:${messageID}]` }] },
      ] as Array<{ role: string; content: unknown }>,
    });
    const owner = request('one');
    await f.substitutePrompt(owner);
    expect(JSON.stringify(owner.messages)).not.toContain('the findings');
    const ran = request('linked');
    await f.substitutePrompt(ran);
    expect(ran.messages[0].content).toEqual([{ type: 'text', text: 'the findings' }]);
    await f.claims.records.save({ ...stored, startedAt: undefined }, stored);
    const unstarted = request('linked');
    await f.substitutePrompt(unstarted);
    expect(JSON.stringify(unstarted.messages)).not.toContain('the findings');
    f.close();
  });

  test('restores the task of the turn a compaction removed the placeholder from', async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const compacted = {
      sessionID: 'linked',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Summary so far' }] },
      ] as Array<{
        role: string;
        content: unknown;
      }>,
    };
    await f.substitutePrompt(compacted, stored);
    expect(compacted.messages.map((msg) => msg.content)).toEqual([
      [{ type: 'text', text: 'the findings' }],
      [{ type: 'text', text: 'Summary so far' }],
    ]);
    // With the placeholder still there, the task replaces it, once.
    const tagged = {
      sessionID: 'linked',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Task\n\n[forgekeeper:${messageID}]` }] },
      ] as Array<{ role: string; content: unknown }>,
    };
    await f.substitutePrompt(tagged, stored);
    expect(tagged.messages).toHaveLength(1);
    // Another session's request never gets it.
    const other = { sessionID: 'one', messages: [] as unknown[] };
    await f.substitutePrompt(other, stored);
    expect(other.messages).toEqual([]);
    f.close();
  });

  test('the linked session, not the owner, holds the preparation', async () => {
    const f = hostFixture();
    const stored: AutomationRecord = {
      ...record,
      execution: {
        stage: 'submitting',
        ownerDirectory: '/repo',
        head,
        sourceProject: 'group/project',
        sourceBranch: 'feature',
        provider: 'local-worktree',
        version: 1,
        state: { directory: '/worktree', sessionID: 'linked' },
        prompt: 'the findings',
      },
    };
    await f.claims.records.save(stored);
    const ctx = {
      session: { context: async () => [message('user', messageID, 5)] },
    } as unknown as Plugin.Context;
    expect(await storedPreparation(ctx, f.claims, 'linked')).toEqual(stored);
    await expect(storedPreparation(ctx, f.claims, 'one')).rejects.toThrow('unavailable');
    f.close();
  });

  test('extracts the final assistant report for a linked turn, including after compaction', () => {
    const assistant = (id: string, at: number, text: string) =>
      message('assistant', id, at, { content: [{ type: 'text', text }] });
    const toolOnly = (id: string, at: number) =>
      message('assistant', id, at, { content: [{ type: 'tool', id: 't1', name: 'shell' }] });
    expect(
      extractTurnReport(
        [
          message('user', messageID, 10),
          assistant('a1', 11, 'Checking pipeline logs...'),
          toolOnly('a2', 12),
          assistant('a3', 13, 'Root cause: missing coverage on collect_stats.'),
          message('idle', 'i1', 14, { outcome: 'succeeded' }),
          message('user', 'u2', 20),
          assistant('a4', 21, 'Follow-up turn text that belongs to a later turn.'),
        ],
        { messageID, startedAt: 10 },
      ),
    ).toBe('Root cause: missing coverage on collect_stats.');
    expect(
      extractTurnReport(
        [
          message('compaction', 'c1', 15),
          assistant('a1', 20, 'Compacted turn final report.'),
          message('idle', 'i1', 25, { outcome: 'succeeded' }),
          message('user', 'u2', 30),
          assistant('a2', 35, 'Later turn.'),
        ],
        { messageID, startedAt: 10, ended: { outcome: 'succeeded', at: 25 } },
      ),
    ).toBe('Compacted turn final report.');
    const huge = 'x'.repeat(5_000);
    const clipped = extractTurnReport([message('user', messageID, 10), assistant('a1', 11, huge)], {
      messageID,
      startedAt: 10,
    });
    expect(clipped).toBeDefined();
    expect(clipped!.length).toBeLessThanOrEqual(3_500);
    expect(clipped).toContain('truncated');
  });

  test('formats uncommitted changes on one line unless multiple files changed', () => {
    expect(formatUncommittedChanges(undefined)).toBe('Uncommitted changes: None');
    expect(formatUncommittedChanges('')).toBe('Uncommitted changes: None');
    expect(formatUncommittedChanges('   \n')).toBe('Uncommitted changes: None');
    expect(formatUncommittedChanges(' M scripts/perf/gc/collect_gc_stats.rb')).toBe(
      'Uncommitted changes: M scripts/perf/gc/collect_gc_stats.rb',
    );
    expect(formatUncommittedChanges(' M a.rb\n?? b.rb\n')).toBe(
      'Uncommitted changes:\nM a.rb\n?? b.rb',
    );
  });

  test('surfaces linked-session reports and clear descriptions to the owning session', async () => {
    const jobItem = { ...review, id: 'f1', kind: 'ci-failed' as const, pipeline: 'p1' };
    const ownerMessages: Message[] = [];
    const f = hostFixture({
      sessions: linkedSessions,
      status: ' M scripts/perf/gc/collect_gc_stats.rb',
      transcripts: {
        one: ownerMessages,
        linked: [
          message('user', messageID, 10),
          message('assistant', 'a1', 12, {
            content: [{ type: 'text', text: 'Undercover flagged collect_stats at 0% coverage.' }],
          }),
          message('idle', 'i1', 15, { outcome: 'succeeded' }),
        ],
      },
    });
    const startedAttempt: LinkedRecord = { ...linkedAttempt(jobItem), startedAt: 10 };
    await f.host.notify!(startedAttempt, 'started');
    await f.host.notify!(
      {
        ...startedAttempt,
        state: 'completed',
        reason: 'The investigation finished.',
        ended: { outcome: 'succeeded', at: 15 },
      },
      'ended',
    );
    expect(f.synthetic).toHaveLength(2);
    expect(f.synthetic[0]).toMatchObject({
      sessionID: 'one',
      description: 'Forgekeeper: investigating failed jobs for !1',
      metadata: { forgekeeper: SUMMARY_KIND },
      resume: true,
    });
    expect(f.synthetic[1]).toMatchObject({
      sessionID: 'one',
      description: 'Forgekeeper: failed-job investigation completed for !1',
      metadata: { forgekeeper: SUMMARY_KIND },
      resume: true,
    });
    expect(String(f.synthetic[1].text)).not.toContain('Undercover flagged');
    const deliver = async (index: number) => {
      ownerMessages.push(message('synthetic', String(f.synthetic[index].id), index + 20));
      const request = {
        sessionID: 'one',
        messages: [],
        options: {},
        system: [],
        tools: { bash: {} },
      };
      expect(await f.summaries.prepare(request)).toBe(true);
      expect(Object.keys(request.tools)).toHaveLength(0);
      return JSON.stringify(request.messages);
    };
    expect(await deliver(0)).not.toContain('Undercover flagged');
    const completion = await deliver(1);
    expect(completion).toContain('Undercover flagged collect_stats at 0% coverage.');
    expect(completion).toContain('Uncommitted changes: M scripts/perf/gc/collect_gc_stats.rb');
    // Completed linked session is automatically archived and broadcast via sessionsCleanedUp:
    expect((f.sessions.linked as { time?: { archived?: number } })?.time?.archived).toBeDefined();
    expect(f.cleanedUp).toEqual([['linked']]);

    delete (f.sessions.linked as { time?: { archived?: number } }).time?.archived;
    await f.host.notify!(
      {
        ...linkedAttempt(jobItem),
        state: 'failed',
        reason: 'The pipeline no longer has failed jobs.',
      },
      'ended',
    );
    expect(f.synthetic[2]).toMatchObject({
      description: 'Forgekeeper: failed-job investigation failed for !1',
      resume: true,
    });
    // Failed linked session stays unarchived for inspection:
    expect((f.sessions.linked as { time?: { archived?: number } })?.time?.archived).toBeUndefined();
    expect(f.cleanedUp).toEqual([['linked']]);

    await f.host.notify!(
      {
        ...linkedAttempt(jobItem),
        execution: { stage: 'provisioning', provider: 'local-worktree', version: 1, state: {} },
        state: 'failed',
        manual: true,
        reason: 'No worktree available.',
      },
      'ended',
    );
    expect(f.synthetic[3].resume).toBe(true);
    expect(await deliver(3)).toContain('No worktree available.');

    f.sessions.one = { id: 'one', time: { archived: 1 }, location: { directory: '/owner' } };
    await f.host.notify!({ ...startedAttempt, state: 'completed' }, 'ended');
    expect(f.synthetic).toHaveLength(4);
    f.close();
  });

  test('owner summary delivery handles and cleans up a relay notice posted by a worktree instance', async () => {
    const storage: Record<string, unknown> = {};
    const removed: string[] = [];
    const ownerMessages: Message[] = [];
    const synthetic: Array<Record<string, unknown>> = [];
    const makeCtx = (directory: string) =>
      ({
        location: { directory, project: { id: 'project' } },
        storage: {
          get: async (key: string) => storage[key],
          set: async (key: string, value: unknown) => {
            storage[key] = value;
          },
          remove: async (key: string) => {
            removed.push(key);
            delete storage[key];
          },
        },
        session: {
          context: async () => ownerMessages,
          synthetic: async (input: Record<string, unknown>) => {
            synthetic.push(input);
          },
        },
      }) as unknown as Plugin.Context;
    const summaryHost = {
      closing: () => false,
      inbox: async () => ({ items: [], paused: false }),
      deliverable: async () => true,
      scan: async () => [],
      write: (task: () => Promise<void>) => void task(),
      report: () => {},
    };
    const worktreeSummaries = createSummaryDelivery(
      makeCtx('/worktree'),
      { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      summaryHost,
    );
    const ownerSummaries = createSummaryDelivery(
      makeCtx('/owner'),
      { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      summaryHost,
    );
    await worktreeSummaries.relay(
      'one',
      'Forgekeeper: investigating failed jobs for !1',
      'Worktree: /worktree',
      true,
    );
    expect(synthetic).toHaveLength(1);
    const id = String(synthetic[0].id);
    ownerMessages.push(message('synthetic', id, 10));
    const relayRequest = {
      sessionID: 'one',
      messages: [{ role: 'user', content: [{ type: 'text', text: String(synthetic[0].text) }] }],
      options: {},
      system: [],
      tools: { bash: {} },
    };
    expect(await ownerSummaries.prepare(relayRequest)).toBe(true);
    expect(Object.keys(relayRequest.tools)).toHaveLength(0);
    expect(JSON.stringify(relayRequest.messages)).toContain('Worktree: /worktree');

    ownerMessages.push(message('user', 'u2', 20));
    const userRequest = {
      sessionID: 'one',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Next question' }] }],
      options: {},
      system: [],
      tools: { bash: {} },
    };
    expect(await ownerSummaries.prepare(userRequest)).toBe(false);
    expect(removed).toEqual([`status/summaries/one/${id}`]);
  });

  test('appends non-interactive linked-session instructions only for environment executions', () => {
    const f = hostFixture();
    expect(f.instructions(record)).not.toContain(LINKED_INSTRUCTIONS);
    expect(f.instructions(linkedAttempt())).toContain(LINKED_INSTRUCTIONS);
    f.close();
  });
});
