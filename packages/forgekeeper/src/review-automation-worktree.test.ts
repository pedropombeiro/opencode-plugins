import { describe, expect, test } from 'bun:test';
import { EnvironmentUncertain } from './automation-environment';
import type { FeedbackItem } from './feedback-inbox';
import { automationBatch, Ineligible, type AutomationRecord } from './review-automation';
import {
  finding,
  fixture,
  item,
  linked,
  rule,
  url,
  worktreeFixture,
} from './review-automation-harness';
import { findingsDigest } from './review-preparation';

describe('review automation in a worktree', () => {
  test('runs a batch whose checkout is elsewhere in a linked session, for its owner', async () => {
    const f = worktreeFixture();
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.submitted).toHaveLength(1);
    const [record] = f.submitted;
    expect(record.placement).toBe('environment');
    expect(record.execution).toMatchObject({
      stage: 'submitting',
      state: linked.state,
    });
    expect(record.execution?.stage === 'submitting' && record.execution.prompt).toContain(
      'A finding',
    );
    // The owning session isn't waited for; the linked session runs the turn.
    expect(f.waited).toEqual(['linked']);
    expect(f.record()).toMatchObject({ state: 'completed', item: { sessionID: 'one' } });
    expect(f.notices).toEqual([['ended', 'completed']]);
    expect(f.claim()).toBeUndefined();
  });

  test("a service account's batch reads and restricts by its author's rules in the worktree", async () => {
    const listing = {
      ...rule,
      authors: ['service-bot'],
      allowedModels: ['gitlab/strong'],
      execution: 'environment' as const,
    };
    const other = { ...rule, reviewers: ['alice'], allowedModels: ['gitlab/other'] };
    const read: Array<string[] | undefined> = [];
    const f = worktreeFixture({
      rules: [listing, other],
      validate: async (_item, automatic) => ({
        placement: 'environment',
        rules: automatic ? [listing] : [listing, other],
      }),
      findings: async (_item, reviewers) => {
        read.push(reviewers);
        return [{ ...finding, reviewer: 'gitlabduo' }];
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(read).toEqual([['gitlabduo'], ['gitlabduo']]);
    expect(f.submitted[0]).toMatchObject({
      placement: 'environment',
      models: ['gitlab/strong'],
      execution: { stage: 'submitting', state: linked.state },
    });
    expect(f.record()).toMatchObject({ state: 'completed' });
  });

  test('without the rules allowing it, a checkout elsewhere skips the batch', async () => {
    const f = worktreeFixture({
      validate: async () => {
        throw new Ineligible('The checkout does not match the PR/MR source project and branch');
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record()).toMatchObject({ state: 'skipped' });
    expect(f.submitted).toEqual([]);
  });

  test('a worktree that cannot be prepared ends the attempt before its turn', async () => {
    const f = worktreeFixture({
      provision: async () => {
        throw new Ineligible('The head commit is not available');
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.submitted).toEqual([]);
    expect(f.record()).toMatchObject({
      state: 'failed',
      reason: 'The head commit is not available',
    });
    expect(f.record().startedAt).toBeUndefined();
    expect(f.claim()).toBeUndefined();
    // Nothing ran, so the update gets its normal delivery.
    expect(f.redelivered).toEqual([item.id]);
  });

  test('uncertain provisioning keeps its claim and never submits a task', async () => {
    const f = worktreeFixture({
      provision: async () => {
        throw new EnvironmentUncertain('Creation cannot be confirmed');
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'failed', reason: 'Creation cannot be confirmed' });
    expect(f.claim()).toBeDefined();
    expect(f.submitted).toEqual([]);
  });

  test('after a reload, provisioning resumes through its recorded provider', async () => {
    const f = worktreeFixture();
    const seeded = await f.seed('running');
    const record: AutomationRecord = {
      ...seeded,
      digest: findingsDigest([finding]),
      placement: 'environment',
      execution: { ...linked, stage: 'provisioning', state: {} },
    };
    f.records.set(record.batch, structuredClone(record));
    f.automation.restore([record]);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed' });
    expect(f.claim()).toBeUndefined();
    expect(f.submitted).toHaveLength(1);
  });

  test('a reload keeps watching the linked session of a submitted attempt', async () => {
    const outcomes: string[] = [];
    const f = worktreeFixture({
      outcome: async (claim) => {
        outcomes.push(claim.sessionID);
        return 'completed';
      },
    });
    const seeded = await f.seed('running');
    const record: AutomationRecord = {
      ...seeded,
      startedAt: 50,
      placement: 'environment',
      execution: linked,
    };
    f.records.set(record.batch, structuredClone(record));
    f.automation.restore([record]);
    await f.settled();
    expect(f.waited).toEqual(['linked']);
    expect(f.record()).toMatchObject({ state: 'completed' });
    expect(f.notices).toEqual([['ended', 'completed']]);
  });

  test('changing the default provider does not redirect a stored attempt', async () => {
    const f = worktreeFixture();
    const seeded = await f.seed('running');
    const record: AutomationRecord = {
      ...seeded,
      startedAt: 50,
      placement: 'environment',
      execution: linked,
    };
    f.records.set(record.batch, record);
    f.host.environments!.default = 'other';
    f.automation.restore([record]);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.waited).toEqual(['linked']);
    expect(f.submitted).toEqual([]);
  });

  test('recovery uses the pinned provider and retains unresolved provisioning', async () => {
    const f = worktreeFixture();
    const seeded = await f.seed('running');
    const record: AutomationRecord = {
      ...seeded,
      digest: findingsDigest([finding]),
      placement: 'environment',
      execution: { ...linked, stage: 'provisioning', state: { resource: 'box:123' } },
    };
    f.records.set(record.batch, record);
    f.host.environments!.default = 'other';
    f.host.environments!.providers[0].recover = async () => {
      throw new Error('Provisioning unresolved');
    };
    f.automation.restore([record]);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'failed', execution: { provider: 'fixture' } });
    expect(f.claim()).toBeDefined();
    expect(f.submitted).toEqual([]);
  });

  test('an unavailable provider or unsupported state version retains the claim', async () => {
    for (const execution of [
      { ...linked, provider: 'missing' },
      { ...linked, version: 2 },
    ]) {
      const f = worktreeFixture();
      const seeded = await f.seed('running');
      const record: AutomationRecord = { ...seeded, execution };
      f.records.set(record.batch, record);
      f.automation.restore([record]);
      await f.settled();
      expect(f.record().state).toBe('failed');
      expect(f.claim()).toBeDefined();
      expect(f.submitted).toEqual([]);
      await expect(f.automation.act(item, true)).rejects.toThrow('provider');
      expect(f.claim()).toBeDefined();
    }
  });

  test('a provider can monitor opaque identities without local session access', async () => {
    const f = worktreeFixture();
    const provider = f.host.environments!.providers[0];
    provider.wait = async (record) => {
      expect(record.execution!.state).toEqual(linked.state);
    };
    provider.exists = async () => true;
    provider.outcome = async () => 'completed';
    provider.submit = async (record) => {
      f.records.set(record.batch, { ...record, startedAt: 100 });
    };
    f.host.wait = async () => {
      throw new Error('Local wait must not run');
    };
    f.host.submit = async () => {
      throw new Error('Local submission must not run');
    };
    f.host.outcome = async () => {
      throw new Error('Local transcript must not be read');
    };
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.record().execution).toMatchObject({
      provider: 'fixture',
      version: 1,
      state: linked.state,
    });
  });

  test('a linked turn that ended without a recorded start failed, and says why', async () => {
    // Forgekeeper wasn't running in the worktree, so its first request
    // wasn't checked, and the session only saw the placeholder.
    const f = worktreeFixture({
      submit: async (record) => void structuredClone(record),
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'failed' });
    expect(f.record().reason).toContain('never got its task');
    expect(f.claim()).toBeUndefined();
    expect(f.notices).toEqual([['ended', 'failed']]);
  });

  test("deleting the owning session doesn't end a turn its linked session still runs", async () => {
    const f = worktreeFixture({
      exists: async (sessionID) => sessionID !== 'one',
      outcome: async () => 'running',
    });
    const seeded = await f.seed('running');
    f.records.set(seeded.batch, { ...seeded, placement: 'environment', execution: linked });
    const other = { ...item, sessionID: 'two' };
    await expect(f.automation.act(other)).rejects.toThrow('still running in its linked session');
    expect(f.record().state).toBe('running');
    expect(f.claim()).toBeDefined();
  });

  test('another session takes over once the linked turn of a deleted owner ended', async () => {
    const f = worktreeFixture({
      exists: async (sessionID) => sessionID !== 'one',
      outcome: async () => 'completed',
    });
    const seeded = await f.seed('running');
    f.records.set(seeded.batch, { ...seeded, placement: 'environment', execution: linked });
    const other = { ...item, sessionID: 'two' };
    await f.automation.act(other, true);
    await f.settled();
    // The ended turn was recorded, which freed the PR/MR for the new attempt.
    expect(f.record()).toMatchObject({ attempt: 2, item: { sessionID: 'two' } });
  });

  test('an uncertain linked turn of a deleted owner needs an explicit retry', async () => {
    const f = worktreeFixture({
      exists: async (sessionID) => sessionID !== 'one',
      outcome: async () => 'unknown',
    });
    const seeded = await f.seed('running');
    f.records.set(seeded.batch, { ...seeded, placement: 'environment', execution: linked });
    const other = { ...item, sessionID: 'two' };
    await expect(f.automation.act(other)).rejects.toThrow('Use explicit retry');
    expect(f.record()).toMatchObject({ state: 'failed', attempt: 1 });
    expect(f.record().reason).toContain('uncertain');
    expect(f.claim()).toBeDefined();
    await f.automation.act(other, true);
    await f.settled();
    expect(f.record()).toMatchObject({ attempt: 2, item: { sessionID: 'two' } });
  });

  test("records the end of the linked session's turn, not the owner's", async () => {
    const f = worktreeFixture();
    const seeded = await f.seed('running');
    f.records.set(seeded.batch, {
      ...seeded,
      startedAt: 50,
      placement: 'environment',
      execution: linked,
    });
    await f.automation.turnEnded('one', 'failed', 60);
    expect(f.record().ended).toBeUndefined();
    await f.automation.turnEnded('linked', 'succeeded', 70);
    expect(f.record().ended).toEqual({ outcome: 'succeeded', at: 70 });
  });

  test('a manual action runs in its worktree without waiting for a busy owner', async () => {
    const f = worktreeFixture({
      // The owning session runs a long task on another branch.
      wait: (sessionID) => (sessionID === 'one' ? new Promise<void>(() => {}) : Promise.resolve()),
    });
    await f.automation.act(item);
    await f.settled();
    expect(f.submitted).toHaveLength(1);
    expect(f.record()).toMatchObject({
      state: 'completed',
      manual: true,
      placement: 'environment',
    });
    await f.automation.act(item, true);
    await f.settled();
    expect(f.submitted).toHaveLength(2);
    expect(f.record()).toMatchObject({ state: 'completed', attempt: 2, placement: 'environment' });
  });

  test('a manual action in the owning session still waits for it', async () => {
    const waited: string[] = [];
    const f = fixture({ wait: async (sessionID) => void waited.push(sessionID) });
    await f.automation.act(item);
    await f.settled();
    expect(waited[0]).toBe('one');
    expect(f.record()).toMatchObject({ state: 'completed', manual: true });
    expect(f.record().placement).toBeUndefined();
  });

  describe('while the worktree is prepared', () => {
    const jobRule = {
      on: 'job-failed' as const,
      host: 'gitlab.com',
      projects: ['team/project'],
      action: 'investigate' as const,
    };
    const failure = (id: string, at: number): FeedbackItem => ({
      id,
      kind: 'ci-failed',
      sessionID: 'one',
      url,
      title: 'Job failed',
      links: [`${url}/jobs/${id}`],
      pipeline: 'p1',
      at,
      automationAllowed: true,
    });
    const first = failure('f1', 100);
    const batch = automationBatch(first);
    type Step = 'worktree' | 'session' | 'verification';

    // Investigates `first`, running `during` at each step of the preparation.
    function preparing(during: (step: Step, f: ReturnType<typeof worktreeFixture>) => unknown) {
      const f: ReturnType<typeof worktreeFixture> = worktreeFixture({
        rules: [jobRule],
        pipelineDone: async () => true,
        async provision(_record, update) {
          await update({
            stage: 'provisioning',
            ownerDirectory: '/repo',
            head: 'abc',
            sourceProject: 'team/project',
            sourceBranch: 'feature',
          });
          await during('worktree', f);
          await update({ state: { resource: 'box:123' } });
          await during('session', f);
          return update({ state: linked.state });
        },
        verifyExecution: async () => void (await during('verification', f)),
      });
      f.setItems([first]);
      return f;
    }

    for (const step of ['worktree', 'session', 'verification'] as const)
      test(`a later failure during ${step} preparation joins the attempt`, async () => {
        const second = failure('f2', 200);
        const f = preparing(async (at, f) => {
          if (at !== step) return;
          f.setItems([second]);
          expect(await f.automation.selectAutomatic(second)).toBe(true);
        });
        expect(await f.automation.selectAutomatic(first)).toBe(true);
        await f.settled();
        expect(f.submitted).toHaveLength(1);
        expect(f.submitted[0]).toMatchObject({
          item: { id: 'f2' },
          execution: { stage: 'submitting', state: linked.state },
        });
        expect(f.records.get(batch)).toMatchObject({ state: 'completed', item: { id: 'f2' } });
      });

    test('an attempt ended or replaced meanwhile stops the preparation', async () => {
      const changes: Record<string, (stored: AutomationRecord) => AutomationRecord> = {
        ended: (stored) => ({ ...stored, state: 'failed', reason: 'Canceled' }),
        replaced: (stored) => ({ ...stored, messageID: 'another', attempt: 2 }),
      };
      for (const change of Object.values(changes)) {
        let changed: AutomationRecord | undefined;
        const f = preparing((at, f) => {
          if (at !== 'session') return;
          changed = change(f.records.get(batch)!);
          f.records.set(batch, structuredClone(changed));
        });
        expect(await f.automation.selectAutomatic(first)).toBe(true);
        await f.settled();
        expect(f.submitted).toEqual([]);
        // The other writer's record stays as it stored it.
        expect(f.records.get(batch)).toEqual(changed!);
      }
    });
  });
});
