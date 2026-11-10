import { describe, expect, test } from 'bun:test';
import {
  ADMISSION_CHECKS,
  allowedModelsFor,
  automationBatch,
  automationReviewers,
  createReviewAutomation,
  Ineligible,
  modelRefusal,
  type AutomationHost,
  type AutomationRecord,
  type AutomationState,
  type AutomationStatus,
  type ExecutionOutcome,
} from './review-automation';
import type { FeedbackItem, InboxState } from './feedback-inbox';
import type { CommentDetail, FailedJob } from './forge';
import type { ExecutionClaim } from './review-claim';
import {
  INVESTIGATION_INSTRUCTIONS,
  INVESTIGATION_QUIET_TIME,
  investigationPrompt,
} from './job-investigation';
import { MAX_PREPARATION_PROMPT, preparationMessageID } from './review-preparation';
import { deferred, until } from './testing';

const url = 'https://gitlab.com/team/project/-/merge_requests/1';
const rule = {
  on: 'review' as const,
  host: 'gitlab.com',
  projects: ['team/project'],
  reviewers: ['gitlabduo'],
  action: 'prepare' as const,
};
const item: FeedbackItem = {
  id: 'batch',
  sessionID: 'one',
  url,
  title: 'Feedback',
  links: [`${url}#note_1`],
  commentIDs: ['1'],
  at: 100,
  automationAllowed: true,
};
const job: FailedJob = { id: 'j1', name: 'rspec', stage: 'test', url: `${url}/jobs/1` };
const finding: CommentDetail = {
  id: '1',
  url: `${url}#note_1`,
  username: 'gitlabduo',
  body: 'A finding',
  authorID: '42',
};

function fixture(overrides: Partial<AutomationHost> = {}) {
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
    validate: async () => {},
    redeliver: (entry) => void redelivered.push(entry.id),
    wait: async () => {},
    sleep: async () => {},
    claim: {
      acquire: async (url, value) => {
        if (claims.has(url)) return false;
        claims.set(url, value);
        return true;
      },
      read: async (url) => claims.get(url),
      release: async (url) => {
        claims.delete(url);
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
    async seed(state: AutomationState): Promise<AutomationRecord> {
      const messageID = preparationMessageID(batch, 1);
      const record: AutomationRecord = { item, batch, state, at: 100, attempt: 1, messageID };
      records.set(batch, structuredClone(record));
      if (state === 'running') claims.set(url, { batch, messageID, sessionID: 'one' });
      return record;
    },
  };
}

describe('review automation', () => {
  test('matches only exact hosts and projects', () => {
    const ref = { forge: 'gitlab' as const, host: 'gitlab.com', project: 'team/project', iid: '1' };
    expect(automationReviewers([rule], ref)).toEqual(['gitlabduo']);
    expect(automationReviewers([rule], { ...ref, host: 'other.example.com' })).toEqual([]);
    expect(automationReviewers([rule], { ...ref, project: 'team/project-fork' })).toEqual([]);
  });

  test('does nothing without explicit automation rules', async () => {
    const f = fixture({ rules: [] });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.records.size).toBe(0);
    expect(f.submits()).toBe(0);
  });

  test('enabling automation does not start older inbox updates', async () => {
    const f = fixture();
    expect(await f.automation.selectAutomatic({ ...item, automationAllowed: undefined })).toBe(
      false,
    );
    expect(f.submits()).toBe(0);
  });

  test('prepares one settled batch and never replays completed work', async () => {
    const f = fixture();
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.statuses.map((status) => status.state)).toEqual(['queued', 'running', 'completed']);
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.submits()).toBe(1);
    expect(f.claim()).toBeUndefined();
  });

  test('counts inactive and disabled associations, and keeps an ambiguous batch skipped', async () => {
    let sessions = ['one', 'inactive-disabled'];
    const f = fixture({ associations: async () => sessions });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record().state).toBe('skipped');
    sessions = ['one'];
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record().state).toBe('skipped');
    expect(f.submits()).toBe(0);
  });

  test('stores an ambiguous batch before reading findings, so a failed read cannot reopen it', async () => {
    let sessions = ['one', 'two'];
    let unavailable = true;
    const f = fixture({
      associations: async () => sessions,
      findings: async () => {
        if (unavailable) throw new Error('The forge API is unavailable');
        return [finding];
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record().state).toBe('skipped');
    sessions = ['one'];
    unavailable = false;
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    await f.settled();
    expect(f.submits()).toBe(0);
  });

  test('feedback with different comments gets a fresh ownership check after ambiguity', async () => {
    let sessions = ['one', 'two'];
    const f = fixture({ associations: async () => sessions });
    await f.automation.selectAutomatic(item);
    sessions = ['one'];
    const next = { ...item, commentIDs: ['2'], postedAt: 200 };
    await f.automation.selectAutomatic(next);
    await f.settled();
    expect(f.records.get(automationBatch(next))?.state).toBe('completed');
    expect(f.record().state).toBe('skipped');
    expect(f.submits()).toBe(1);
  });

  test('counts each association once', async () => {
    const f = fixture({ associations: async () => ['one', 'one'] });
    await f.automation.selectAutomatic(item);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.submits()).toBe(1);
  });

  test.each(['pause', 'acknowledge'] as const)(
    '%s cancels queued work before execution',
    async (action) => {
      const gate = deferred();
      const f = fixture({ wait: () => gate.promise });
      await f.automation.selectAutomatic(item);
      f[action]();
      gate.resolve();
      await f.settled();
      expect(f.record().state).toBe('failed');
      expect(f.submits()).toBe(0);
      expect(f.claim()).toBeUndefined();
    },
  );

  test('rechecks ownership after waiting for idle', async () => {
    const gate = deferred();
    let sessions = ['one'];
    const f = fixture({ wait: () => gate.promise, associations: async () => sessions });
    await f.automation.selectAutomatic(item);
    sessions = ['one', 'two'];
    gate.resolve();
    await f.settled();
    expect(f.record().state).toBe('skipped');
    expect(f.submits()).toBe(0);
  });

  test('defers the decision while sessions cannot be enumerated', async () => {
    const f = fixture({
      associations: async () => {
        throw new Error('Cannot enumerate sessions');
      },
    });
    await expect(f.automation.selectAutomatic(item)).rejects.toThrow('Cannot enumerate');
    expect(f.records.size).toBe(0);
    expect(f.submits()).toBe(0);
  });

  test('records a batch without authorized findings as skipped, keeping its normal delivery', async () => {
    let reads = 0;
    const f = fixture({
      findings: async () => {
        reads++;
        return [];
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record().state).toBe('skipped');
    expect(reads).toBe(1);
    expect(f.submits()).toBe(0);
  });

  test('two coordinators selecting one batch run it once', async () => {
    const gate = deferred();
    let submits = 0;
    const f = fixture({
      submit: async () => {
        submits++;
        await gate.promise;
      },
    });
    const second = createReviewAutomation(f.host);
    await Promise.all([f.automation.selectAutomatic(item), second.selectAutomatic(item)]);
    await until(() => f.record().state === 'running');
    expect(f.claim()?.batch).toBe(automationBatch(item));
    gate.resolve();
    await Promise.all([...f.automation.tasks(), ...second.tasks()]);
    expect(f.record().state).toBe('completed');
    expect(submits).toBe(1);
  });

  test('a coordinator that loses the claim to the same attempt leaves its progress alone', async () => {
    const submission = deferred();
    const late = deferred();
    let submits = 0;
    const f = fixture({
      submit: async () => {
        submits++;
        await submission.promise;
      },
    });
    const start = f.host.start;
    f.host.start = async (record, expected) => {
      const won = await start(record, expected);
      if (!won) await late.promise;
      return won;
    };
    const queued = await f.seed('queued');
    const first = createReviewAutomation(f.host);
    const second = createReviewAutomation(f.host);
    first.restore([queued]);
    second.restore([queued]);
    await until(() => f.record().state === 'running');
    late.resolve();
    await Promise.all(second.tasks());
    expect(f.record().state).toBe('running');
    submission.resolve();
    await Promise.all(first.tasks());
    expect(f.record().state).toBe('completed');
    expect(submits).toBe(1);
    expect(f.claim()).toBeUndefined();
  });

  test('a prompt that cannot be built fails before admission and frees the PR/MR', async () => {
    let body = 'x'.repeat(MAX_PREPARATION_PROMPT);
    const f = fixture({ rules: [], findings: async () => [{ ...finding, body }] });
    await f.automation.act(item);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(f.record().reason).toContain('size limit');
    expect(f.record().reason).not.toContain('Inspect the session');
    expect(f.claim()).toBeUndefined();
    body = 'A smaller finding';
    await f.automation.act(item, true);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.submits()).toBe(1);
  });

  test('a running record is reconciled after reload without replaying an uncertain task', async () => {
    const f = fixture({ outcome: async () => 'unknown' });
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(f.record().reason).toContain('uncertain');
    expect(f.submits()).toBe(0);
    expect(f.claim()).toBeDefined();
  });

  test('a running record that finished during the reload is completed, freeing the PR/MR', async () => {
    const f = fixture();
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.submits()).toBe(0);
    expect(f.claim()).toBeUndefined();
  });

  test('keeps monitoring a restored turn after its update is acknowledged', async () => {
    const outcomes: ExecutionOutcome[] = ['running', 'running', 'completed'];
    let sleeps = 0;
    const f = fixture({
      outcome: async () => outcomes.shift() ?? 'completed',
      sleep: async () => {
        sleeps++;
      },
    });
    const running = await f.seed('running');
    f.acknowledge();
    f.automation.restore([running]);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.claim()).toBeUndefined();
    expect(sleeps).toBe(2);
  });

  test('waits a bounded time for a prompt to be admitted, then fails as uncertain', async () => {
    let sleeps = 0;
    const f = fixture({
      outcome: async () => 'pending',
      sleep: async () => {
        sleeps++;
      },
    });
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(sleeps).toBe(ADMISSION_CHECKS);
    expect(f.claim()).toBeDefined();
  });

  test('abandoning a turn refused before its first request frees the PR/MR', async () => {
    const f = fixture();
    const running = await f.seed('running');
    await f.automation.abandon(running, 'The review findings changed');
    expect(f.record().state).toBe('failed');
    expect(f.record().reason).toBe('The review findings changed');
    expect(f.claim()).toBeUndefined();
  });

  test('an interrupted admission becomes failed and explicitly retryable without replay', async () => {
    let outcome: ExecutionOutcome = 'pending';
    const f = fixture({ outcome: async () => outcome });
    const admitted = await f.seed('running');
    f.automation.restore([admitted]);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(f.submits()).toBe(0);
    expect(f.claim()).toBeDefined();
    await f.automation.act(item, true);
    outcome = 'completed';
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', attempt: 2 });
    expect(f.submits()).toBe(1);
    expect(f.claim()).toBeUndefined();
  });

  test('a failed status update after completion still frees the PR/MR for the next batch', async () => {
    const f = fixture();
    const status = f.host.status;
    const automation = createReviewAutomation({
      ...f.host,
      status: async (entry, record) => {
        if (record.state === 'completed') throw new Error('Inbox write failed');
        await status(entry, record);
      },
      error: () => {},
    });
    await automation.act(item);
    await Promise.all(automation.tasks());
    expect(f.record().state).toBe('completed');
    expect(f.claim()).toBeUndefined();
    await automation.act({ ...item, commentIDs: ['2'], at: 200 });
    await Promise.all(automation.tasks());
    expect(f.submits()).toBe(2);
  });

  test('a check that fails for a moment is retried instead of failing the attempt', async () => {
    let failures = ADMISSION_CHECKS - 1;
    const f = fixture({
      outcome: async () => {
        if (failures-- > 0) throw new Error('context unavailable');
        return 'completed';
      },
    });
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.claim()).toBeUndefined();
  });

  test.each(['manual', 'automatic'] as const)(
    'a failed attempt whose turn finished does not block %s action on later feedback',
    async (mode) => {
      let unavailable = true;
      const next = { ...item, id: 'next', commentIDs: ['2'], postedAt: 200 };
      const f = fixture({
        outcome: async () => {
          if (unavailable) throw new Error('context unavailable');
          return 'completed';
        },
        error: () => {},
      });
      f.automation.restore([await f.seed('running')]);
      await f.settled();
      expect(f.record()).toMatchObject({ state: 'failed' });
      expect(f.claim()?.batch).toBe(automationBatch(item));
      unavailable = false;
      f.acknowledge();
      f.host.inbox = async () => ({ items: [next], paused: false });
      if (mode === 'manual') await f.automation.act(next);
      else expect(await f.automation.selectAutomatic(next)).toBe(true);
      await f.settled();
      expect(f.records.get(automationBatch(next))?.state).toBe('completed');
      expect(f.record().state).toBe('failed');
      expect(f.claim()).toBeUndefined();
      expect(f.submits()).toBe(1);
    },
  );

  test('an uncertain claim from another batch needs an explicit retry, which clears it', async () => {
    const next = { ...item, id: 'next', commentIDs: ['2'], postedAt: 200 };
    let outcome: ExecutionOutcome = 'unknown';
    const f = fixture({ outcome: async () => outcome });
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    expect(f.record().state).toBe('failed');
    f.host.inbox = async () => ({ items: [next], paused: false });
    await expect(f.automation.act(next)).rejects.toThrow('Retry feedback work');
    expect(f.claim()?.batch).toBe(automationBatch(item));
    await f.automation.act(next, true);
    outcome = 'completed';
    await f.settled();
    expect(f.records.get(automationBatch(next))?.state).toBe('completed');
    expect(f.claim()).toBeUndefined();
  });

  test('an explicit retry never frees the claim of a turn that is still running', async () => {
    const next = { ...item, id: 'next', commentIDs: ['2'], postedAt: 200 };
    const f = fixture({ outcome: async () => 'unknown' });
    f.automation.restore([await f.seed('running')]);
    await f.settled();
    f.host.outcome = async () => 'running';
    f.host.inbox = async () => ({ items: [next], paused: false });
    await expect(f.automation.act(next, true)).rejects.toThrow('still running');
    expect(f.claim()?.batch).toBe(automationBatch(item));
    expect(f.records.get(automationBatch(next))).toBeUndefined();
  });

  test('records only the first turn end after a running attempt started', async () => {
    const f = fixture();
    const running = { ...(await f.seed('running')), startedAt: 50 };
    f.records.set(running.batch, running);
    await f.automation.turnEnded('one', 'succeeded', 40);
    expect(f.record().ended).toBeUndefined();
    await f.automation.turnEnded('two', 'succeeded', 60);
    expect(f.record().ended).toBeUndefined();
    await f.automation.turnEnded('one', 'failed', 60);
    await f.automation.turnEnded('one', 'succeeded', 70);
    expect(f.record().ended).toEqual({ outcome: 'failed', at: 60 });
  });

  test('a delayed skip cannot overwrite another coordinator admission', async () => {
    const saving = deferred();
    const release = deferred();
    const submission = deferred();
    const f = fixture({ submit: () => submission.promise });
    const save = f.host.save;
    const stale = createReviewAutomation({
      ...f.host,
      associations: async () => ['one', 'two'],
      save: async (record, expected) => {
        if (record.state === 'skipped') {
          saving.resolve();
          await release.promise;
        }
        return save(record, expected);
      },
    });
    const queued = await f.seed('queued');
    stale.restore([queued]);
    await saving.promise;
    f.automation.restore([queued]);
    await until(() => f.record().state === 'running');
    release.resolve();
    await Promise.all(stale.tasks());
    expect(f.record().state).toBe('running');
    submission.resolve();
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.claim()).toBeUndefined();
  });

  test('a stale coordinator cannot reopen a finished attempt', async () => {
    const f = fixture();
    const queued = await f.seed('queued');
    await f.seed('completed');
    f.automation.restore([queued]);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.submits()).toBe(0);
  });

  test('manual action works without rules, and retry is explicit', async () => {
    const f = fixture({ rules: [] });
    await f.automation.act(item);
    await f.settled();
    expect(f.record().state).toBe('completed');
    await expect(f.automation.act(item)).rejects.toThrow('explicit retry');
    await f.automation.act(item, true);
    await f.settled();
    expect(f.record().state).toBe('completed');
    expect(f.record().attempt).toBe(2);
    expect(f.submits()).toBe(2);
  });

  test('manual action starts a skipped batch without retry, and still checks ownership', async () => {
    let sessions = ['one', 'two'];
    const f = fixture({ associations: async () => sessions });
    await f.automation.selectAutomatic(item);
    expect(f.record().state).toBe('skipped');
    await f.automation.act(item);
    expect(f.record()).toMatchObject({ state: 'skipped', attempt: 2 });
    sessions = ['one'];
    await f.automation.act(item);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', attempt: 3, manual: true });
    expect(f.submits()).toBe(1);
  });

  test('manual action moves a skipped batch to the session that now owns the PR/MR', async () => {
    let sessions = ['one', 'two'];
    const f = fixture({ associations: async () => sessions });
    await f.automation.selectAutomatic(item);
    expect(f.record().state).toBe('skipped');
    const other = { ...item, id: 'other', sessionID: 'two' };
    f.host.inbox = async () => ({ items: [other], paused: false });
    sessions = ['two'];
    expect(await f.automation.selectAutomatic(other)).toBe(false);
    expect(f.submits()).toBe(0);
    await f.automation.act(other);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', attempt: 2, manual: true });
    expect(f.record().item.sessionID).toBe('two');
    expect(f.submits()).toBe(1);
  });

  test('a batch that ran stays with its session while that session exists', async () => {
    const f = fixture({ rules: [] });
    await f.automation.act(item);
    await f.settled();
    const other = { ...item, id: 'other', sessionID: 'two' };
    f.host.inbox = async () => ({ items: [other], paused: false });
    f.host.associations = async () => ['two'];
    await expect(f.automation.act(other, true)).rejects.toThrow('belongs to another session');
    f.host.exists = async (sessionID) => sessionID !== 'one';
    await f.automation.act(other, true);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', attempt: 2 });
    expect(f.record().item.sessionID).toBe('two');
  });

  test.each(['running', 'failed'] as const)(
    "a deleted session's %s attempt frees the PR/MR for later feedback",
    async (state) => {
      const next = { ...item, id: 'next', sessionID: 'two', commentIDs: ['2'], postedAt: 200 };
      const f = fixture({
        exists: async (sessionID) => sessionID !== 'one',
        outcome: async (claim) => {
          if (claim.sessionID === 'one') throw new Error('Session not found');
          return 'completed';
        },
        associations: async () => ['two'],
      });
      const seeded = await f.seed('running');
      if (state === 'failed') f.records.set(seeded.batch, { ...seeded, state: 'failed' });
      f.host.inbox = async () => ({ items: [next], paused: false });
      await f.automation.act(next);
      await f.settled();
      expect(f.record()).toMatchObject({ state: 'failed' });
      if (state === 'running') expect(f.record().reason).toBe('The owning session was deleted.');
      expect(f.records.get(automationBatch(next))?.state).toBe('completed');
      expect(f.claim()).toBeUndefined();
    },
  );

  test('an explicit retry keeps the claim while a session that cannot be read might still run', async () => {
    const next = { ...item, id: 'next', commentIDs: ['2'], postedAt: 200 };
    const f = fixture({
      exists: async () => {
        throw new Error('Session store unavailable');
      },
    });
    await f.seed('running');
    f.host.inbox = async () => ({ items: [next], paused: false });
    await expect(f.automation.act(next, true)).rejects.toThrow('unavailable');
    expect(f.claim()?.batch).toBe(automationBatch(item));
  });

  test("skips another author's PR/MR before queuing, keeping its normal delivery", async () => {
    const validations: boolean[] = [];
    const f = fixture({
      validate: async (_item, automatic) => {
        validations.push(automatic);
        if (automatic) throw new Ineligible('You did not write this PR/MR');
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record()).toMatchObject({ state: 'skipped', reason: 'You did not write this PR/MR' });
    expect(f.submits()).toBe(0);
    await f.automation.act(item);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', manual: true });
    expect(validations).toEqual([true, false, false]);
  });

  test("each reviewer's findings need a model one of the reviewer's rules allows", () => {
    const ref = { forge: 'gitlab' as const, host: 'gitlab.com', project: 'team/project', iid: '1' };
    const rules = [
      { ...rule, allowedModels: ['gitlab/strong', 'gitlab/other'] },
      { ...rule, reviewers: ['security'], allowedModels: ['gitlab/strong'] },
      { ...rule, reviewers: ['security'], allowedModels: ['gitlab/audit'] },
      { ...rule, reviewers: ['bot'] },
      { ...rule, projects: ['team/elsewhere'], reviewers: ['bot'], allowedModels: ['x/y'] },
    ];
    const by = (...reviewers: Array<string | undefined>) =>
      reviewers.map((reviewer) => ({ ...finding, reviewer }));
    expect(allowedModelsFor(rules, ref, by('gitlabduo'))).toEqual([
      'gitlab/strong',
      'gitlab/other',
    ]);
    expect(allowedModelsFor(rules, ref, by('security'))).toEqual(['gitlab/strong', 'gitlab/audit']);
    expect(allowedModelsFor(rules, ref, by('gitlabduo', 'security'))).toEqual(['gitlab/strong']);
    expect(allowedModelsFor(rules, ref, by('bot', undefined))).toBeUndefined();
    expect(allowedModelsFor([rule], ref, by('gitlabduo'))).toBeUndefined();
    expect(modelRefusal(undefined, undefined, 'act')).toBeUndefined();
    expect(modelRefusal(['gitlab/strong'], 'gitlab/strong', 'act')).toBeUndefined();
    const needs =
      'Review automation needs one of these models: gitlab/strong. This session uses gitlab/cheap.';
    expect(modelRefusal(['gitlab/strong'], 'gitlab/cheap', 'act')).toBe(
      `${needs} Switch models, then use Act on feedback.`,
    );
    expect(modelRefusal(['gitlab/strong'], 'gitlab/cheap', 'retry')).toBe(
      `${needs} Switch models, then use Retry feedback work.`,
    );
    expect(modelRefusal(['gitlab/strong'], 'gitlab/cheap', 'inspect')).toBe(
      `${needs} The turn may have made changes. Inspect the session, switch models, then use Retry feedback work.`,
    );
    expect(modelRefusal([], 'gitlab/strong', 'act')).toContain('No model is allowed');
  });

  test('skips a batch the session model may not act on, keeping its normal delivery', async () => {
    let model = 'gitlab/cheap';
    const f = fixture({
      rules: [{ ...rule, allowedModels: ['gitlab/strong'] }],
      findings: async () => [{ ...finding, reviewer: 'gitlabduo' }],
      model: async () => model,
    });
    expect(await f.automation.selectAutomatic(item)).toBe(false);
    expect(f.record().state).toBe('skipped');
    expect(f.record().reason).toContain('This session uses gitlab/cheap');
    expect(f.submits()).toBe(0);
    model = 'gitlab/strong';
    await f.automation.act(item);
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'completed', manual: true });
  });

  test("manual action reads everyone's findings and honors restricted reviewers' models", async () => {
    const reads: Array<[string[] | undefined, readonly string[] | undefined]> = [];
    const f = fixture({
      rules: [
        { ...rule, allowedModels: ['gitlab/strong'] },
        { ...rule, reviewers: ['bot'] },
      ],
      findings: async (_item, reviewers, tagged) => {
        reads.push([reviewers, tagged]);
        return [
          { ...finding, reviewer: 'gitlabduo' },
          { ...finding, id: '2' },
        ];
      },
      model: async () => 'gitlab/cheap',
    });
    await f.automation.act(item);
    await f.settled();
    expect(f.record().state).toBe('skipped');
    expect(f.record().reason).toContain('needs one of these models: gitlab/strong');
    expect(reads).toEqual([[undefined, ['gitlabduo']]]);
    expect(f.submits()).toBe(0);
  });

  test('a queued batch whose session switched to a disallowed model is skipped', async () => {
    let model = 'gitlab/strong';
    const gate = deferred();
    const f = fixture({
      rules: [{ ...rule, allowedModels: ['gitlab/strong'] }],
      findings: async () => [{ ...finding, reviewer: 'gitlabduo' }],
      model: async () => model,
      wait: () => gate.promise,
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    model = 'gitlab/cheap';
    gate.resolve();
    await f.settled();
    expect(f.record().state).toBe('skipped');
    expect(f.redelivered).toEqual([item.id]);
  });

  test('a check that fails to run before queuing is retried, not skipped', async () => {
    const f = fixture({
      validate: async () => {
        throw new Error('The forge API is unavailable');
      },
    });
    await expect(f.automation.selectAutomatic(item)).rejects.toThrow('unavailable');
    expect(f.records.size).toBe(0);
  });

  test('a queued batch ruled out before it runs is skipped and handed back to delivery', async () => {
    let eligible = true;
    const gate = deferred();
    const f = fixture({
      wait: () => gate.promise,
      validate: async () => {
        if (!eligible) throw new Ineligible('The checkout does not match');
      },
    });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    eligible = false;
    gate.resolve();
    await f.settled();
    expect(f.record()).toMatchObject({ state: 'skipped', reason: 'The checkout does not match' });
    expect(f.redelivered).toEqual([item.id]);
    expect(await f.automation.selectAutomatic(item)).toBe(false);
  });

  test('an attempt that failed before its turn started hands the update back to delivery', async () => {
    const f = fixture({ findings: async () => [{ ...finding, body: 'x'.repeat(100_000) }] });
    expect(await f.automation.selectAutomatic(item)).toBe(true);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(f.redelivered).toEqual([item.id]);
    expect(await f.automation.selectAutomatic(item)).toBe(false);
  });

  test('an attempt whose turn started keeps delivery, even when it fails', async () => {
    const f = fixture({ outcome: async () => 'failed' });
    const running = { ...(await f.seed('running')), startedAt: 50 };
    f.records.set(running.batch, running);
    f.automation.restore([running]);
    await f.settled();
    expect(f.record().state).toBe('failed');
    expect(f.redelivered).toEqual([]);
    expect(await f.automation.selectAutomatic(item)).toBe(true);
  });

  test('a batch identity is shared across sessions and ignores comment ordering', () => {
    expect(automationBatch({ ...item, commentIDs: ['2', '1'] })).toBe(
      automationBatch({ ...item, sessionID: 'two', commentIDs: ['1', '2'] }),
    );
  });
});

describe('failed-job automation', () => {
  const jobRule = {
    on: 'job-failed' as const,
    host: 'gitlab.com',
    projects: ['team/project'],
    action: 'investigate' as const,
  };
  const failure = (id: string, at: number, pipeline = 'p1'): FeedbackItem => ({
    id,
    kind: 'ci-failed',
    sessionID: 'one',
    url,
    title: 'Job failed',
    links: [`${url}/jobs/${id}`],
    pipeline,
    at,
    automationAllowed: true,
  });

  // A clock that sleeps advance, so the quiet time passes in the test.
  function jobFixture(overrides: Partial<AutomationHost> = {}) {
    let clock = 1_000;
    const texts: string[] = [];
    const f = fixture({
      rules: [jobRule],
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      submit: async (_record, text) => void texts.push(text),
      ...overrides,
    });
    return {
      ...f,
      texts,
      tick: (ms: number) => void (clock += ms),
      at: () => clock,
    };
  }

  test('only projects with a job-failed rule start investigations', async () => {
    const f = jobFixture({ rules: [rule] });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    expect(await f.automation.selectAutomatic(first)).toBe(false);
    expect(f.records.size).toBe(0);
    // A job-failed rule doesn't cover review feedback either.
    const g = jobFixture();
    expect(await g.automation.selectAutomatic(item)).toBe(false);
  });

  test('investigates a pipeline once, after its failures go quiet', async () => {
    const gate = deferred();
    const f = jobFixture({ wait: () => gate.promise });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    expect(await f.automation.selectAutomatic(first)).toBe(true);
    // A later failure replaces the update and joins the queued batch.
    const second = failure('f2', 2_000);
    f.setItems([second]);
    expect(await f.automation.selectAutomatic(second)).toBe(true);
    const batch = automationBatch(first);
    expect(automationBatch(second)).toBe(batch);
    expect(f.records.get(batch)?.item.id).toBe('f2');
    gate.resolve();
    await f.settled();
    const record = f.records.get(batch)!;
    expect(record.state).toBe('completed');
    expect(record.reason).toContain('investigation finished');
    expect(f.at() - 2_000).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
    expect(f.texts).toHaveLength(1);
    expect(f.texts[0]).toContain('untrusted JSON data');
    expect(f.texts[0]).toContain('"name":"rspec"');
    // A failure after the turn ran doesn't start another one.
    const third = failure('f3', f.at());
    f.setItems([third]);
    expect(await f.automation.selectAutomatic(third)).toBe(true);
    await f.settled();
    expect(f.texts).toHaveLength(1);
  });

  test('a failure while the session is busy restarts the quiet time', async () => {
    const waiting = deferred();
    const gate = deferred();
    const starts: number[] = [];
    const f = jobFixture({
      wait: async () => {
        waiting.resolve();
        await gate.promise;
      },
      submit: async (record) => void starts.push(record.item.at),
    });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await waiting.promise;
    const second = failure('f2', f.at());
    f.setItems([second]);
    await f.automation.selectAutomatic(second);
    gate.resolve();
    await f.settled();
    expect(starts).toEqual([second.at]);
    expect(f.at() - second.at).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
    expect(f.records.get(automationBatch(first))?.state).toBe('completed');
  });

  test('a manual investigation without a rule also takes in replacement failures', async () => {
    const waiting = deferred();
    const gate = deferred();
    const starts: string[] = [];
    const f = jobFixture({
      rules: [],
      wait: async () => {
        waiting.resolve();
        await gate.promise;
      },
      submit: async (record) => void starts.push(record.item.id),
    });
    const manual = (id: string, at: number) => ({
      ...failure(id, at),
      automationAllowed: undefined,
    });
    const first = manual('f1', 1_000);
    f.setItems([first]);
    await f.automation.act(first);
    await waiting.promise;
    // A later failure replaces the update, and joins the queued batch.
    const second = manual('f2', f.at());
    f.setItems([second]);
    expect(await f.automation.selectAutomatic(second)).toBe(true);
    gate.resolve();
    await f.settled();
    expect(starts).toEqual(['f2']);
    expect(f.at() - second.at).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
    expect(f.records.get(automationBatch(first))?.state).toBe('completed');
    // Once the batch ran, a later failure gets no summary.
    const third = manual('f3', f.at());
    f.setItems([third]);
    expect(await f.automation.selectAutomatic(third)).toBe(true);
    // Without a batch or a rule, the update keeps its normal delivery.
    const other = { ...manual('h1', f.at()), pipeline: 'p2' };
    f.setItems([other]);
    expect(await f.automation.selectAutomatic(other)).toBe(false);
    expect(f.records.has(automationBatch(other))).toBe(false);
    await f.settled();
    expect(starts).toEqual(['f2']);
  });

  test('a failure during admission waits again instead of skipping the batch', async () => {
    const f = jobFixture();
    const start = f.host.start;
    const first = failure('f1', 1_000);
    let second: FeedbackItem | undefined;
    f.host.start = async (record, expected) => {
      if (!second) {
        second = failure('f2', f.at());
        f.setItems([second]);
        await f.automation.selectAutomatic(second);
      }
      return start(record, expected);
    };
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await f.settled();
    const record = f.records.get(automationBatch(first))!;
    expect(record).toMatchObject({ state: 'completed', item: { id: 'f2' } });
    expect(f.at() - second!.at).toBeGreaterThanOrEqual(INVESTIGATION_QUIET_TIME);
    expect(f.texts).toHaveLength(1);
  });

  test('tells the agent to list the current failed jobs, and when the list is partial', () => {
    const failures = { pipeline: { id: 'p1' }, jobs: [job], unlisted: false, complete: true };
    expect(investigationPrompt(url, failures)).toContain('List its current failed jobs');
    expect(investigationPrompt(url, { ...failures, complete: false })).toContain(
      'listed only some of the failed jobs',
    );
    expect(INVESTIGATION_INSTRUCTIONS).toContain('First list the pipeline’s current failed jobs');
  });

  test('starts without waiting out the quiet time once the pipeline finishes', async () => {
    const f = jobFixture({ pipelineDone: async () => true });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await f.settled();
    expect(f.records.get(automationBatch(first))?.state).toBe('completed');
    expect(f.at()).toBe(1_000);
  });

  test('another pipeline is another batch', () => {
    expect(automationBatch(failure('f1', 1, 'p1'))).not.toBe(
      automationBatch(failure('f2', 1, 'p2')),
    );
  });

  test('skips a pipeline the checkout has moved past, with the reason, and keeps normal delivery', async () => {
    const reason = "The checkout isn't at the head commit that the failing pipeline tested";
    const f = jobFixture({
      validate: async () => {
        throw new Ineligible(reason);
      },
    });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    expect(await f.automation.selectAutomatic(first)).toBe(false);
    expect(f.records.get(automationBatch(first))).toMatchObject({ state: 'skipped', reason });
    expect(f.texts).toHaveLength(0);
  });

  test('skips the batch when the pipeline no longer fails by the time it is quiet', async () => {
    const f = jobFixture({
      failures: async () => {
        throw new Ineligible('The pipeline no longer has failed jobs.');
      },
    });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await f.settled();
    expect(f.records.get(automationBatch(first))?.state).toBe('skipped');
    expect(f.redelivered).toEqual(['f1']);
    expect(f.texts).toHaveLength(0);
  });

  test('skips an ambiguous owner', async () => {
    const f = jobFixture({ associations: async () => ['one', 'two'] });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    expect(await f.automation.selectAutomatic(first)).toBe(false);
    expect(f.records.get(automationBatch(first))?.state).toBe('skipped');
  });

  test('refuses a model the rule does not allow', async () => {
    const f = jobFixture({ rules: [{ ...jobRule, allowedModels: ['gitlab/other'] }] });
    const first = failure('f1', 1_000);
    f.setItems([first]);
    expect(await f.automation.selectAutomatic(first)).toBe(false);
    expect(f.records.get(automationBatch(first))?.reason).toContain('gitlab/other');
  });

  test('an explicit retry investigates the pipeline again', async () => {
    const f = jobFixture();
    const first = failure('f1', 1_000);
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await f.settled();
    await expect(f.automation.act(first)).rejects.toThrow('Use explicit retry');
    await f.automation.act(first, true);
    await f.settled();
    expect(f.records.get(automationBatch(first))).toMatchObject({
      state: 'completed',
      attempt: 2,
    });
    expect(f.texts).toHaveLength(2);
  });

  test('a reload resumes a queued pipeline batch', async () => {
    const f = jobFixture();
    const first = failure('f1', 1_000);
    f.setItems([first]);
    const batch = automationBatch(first);
    const record: AutomationRecord = {
      item: first,
      batch,
      state: 'queued',
      at: 1_000,
      attempt: 1,
      messageID: preparationMessageID(batch, 1),
    };
    f.records.set(batch, record);
    f.automation.restore([record]);
    await f.settled();
    expect(f.records.get(batch)?.state).toBe('completed');
    expect(f.texts).toHaveLength(1);
  });
});
