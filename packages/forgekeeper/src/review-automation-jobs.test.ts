import { describe, expect, test } from 'bun:test';
import type { FeedbackItem } from './feedback-inbox';
import {
  INVESTIGATION_INSTRUCTIONS,
  INVESTIGATION_QUIET_TIME,
  investigationPrompt,
} from './job-investigation';
import {
  automationBatch,
  Ineligible,
  type AutomationHost,
  type AutomationRecord,
} from './review-automation';
import { fixture, item, job, rule, url } from './review-automation-harness';
import { preparationMessageID } from './review-preparation';
import { deferred } from './testing';

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

  test('a failure after admission, before the first model request, joins the batch', async () => {
    const f = jobFixture();
    const first = failure('f1', 1_000);
    let second: FeedbackItem | undefined;
    // The prompt is submitted, so the attempt runs, but its first model
    // request hasn't started.
    f.host.submit = async () => {
      second = failure('f2', f.at());
      f.setItems([second]);
      expect(await f.automation.selectAutomatic(second)).toBe(true);
    };
    f.setItems([first]);
    await f.automation.selectAutomatic(first);
    await f.settled();
    const record = f.records.get(automationBatch(first))!;
    expect(record.item.id).toBe('f2');
    // Once the first request starts, later failures no longer join.
    f.records.set(record.batch, { ...record, state: 'running', startedAt: f.at() });
    const third = failure('f3', f.at());
    f.setItems([third]);
    expect(await f.automation.selectAutomatic(third)).toBe(true);
    expect(f.records.get(record.batch)!.item.id).toBe('f2');
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

  test("restricts models by the job rules that cover the PR/MR's author", async () => {
    const listing = { ...jobRule, authors: ['service-bot'], allowedModels: ['gitlab/other'] };
    const f = jobFixture({
      rules: [listing, jobRule],
      validate: async () => ({ placement: 'session', rules: [listing] }),
    });
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
