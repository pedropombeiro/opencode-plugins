import { describe, expect, test } from 'bun:test';
import { createHealth, THRESHOLDS, type Finding, type Health, type IncidentRecord } from './health';
import { healthLines, healthTip } from './tips';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TTL = 5 * MINUTE;
const opus = { providerID: 'anthropic', id: 'opus' };
const sol = { providerID: 'openai', id: 'sol' };

interface Step {
  read?: number;
  write?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  gap?: number;
  session?: string;
  model?: { providerID: string; id: string; variant?: string };
  priced?: boolean;
  id?: string;
  agent?: string;
}

const cold: Step = { write: 100_000, input: 1000 };
const warm: Step = { read: 95_000, write: 3000, input: 2000 };
const miss: Step = { write: 100_000, input: 1000 };

function driver(health: Health = createHealth()) {
  let clock = 0;
  let count = 0;
  const findings: Finding[] = [];
  function step(value: Step) {
    clock += value.gap ?? 30 * SECOND;
    count += 1;
    const finding = health.observe({
      sessionID: value.session ?? 's',
      stepID: value.id ?? `step-${count}`,
      model: value.model ?? opus,
      ...(value.agent ? { agent: value.agent } : {}),
      started: clock,
      ttl: TTL,
      cachePriced: value.priced ?? false,
      tokens: {
        input: value.input ?? 0,
        output: value.output ?? 500,
        reasoning: value.reasoning ?? 0,
        cache: { read: value.read ?? 0, write: value.write ?? 0 },
      },
    });
    if (finding) findings.push(finding);
    return finding;
  }
  const repeat = (times: number, value: Step) => {
    for (let index = 0; index < times; index += 1) step(value);
  };
  return { health, findings, step, repeat, now: () => clock };
}

describe('createHealth', () => {
  test('allows warm-up and stays quiet while reads are healthy', () => {
    const { findings, step, repeat, health } = driver();
    step(cold);
    repeat(8, warm);
    expect(findings).toEqual([]);
    expect(health.status('s', opus)).toMatchObject({ kind: 'ok' });
  });

  test('detects sustained misses after warm-up and flags them once when they persist', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(3, miss);
    expect(findings).toEqual([]);
    step(miss);
    repeat(2, miss);
    expect(findings).toHaveLength(1);
    repeat(4, miss);
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'persistent']);
    expect(findings[1]).toMatchObject({
      incident: 1,
      record: {
        requests: 7,
        lost: 707_000,
        pattern: 'full',
        open: true,
        notified: true,
        assumed: false,
      },
    });
    expect(findings[1]).not.toHaveProperty('record.extra');
    expect(findings[0]).toMatchObject({
      type: 'low',
      reason: 'miss',
      incident: 1,
      assumed: false,
      window: { requests: 4, share: 0, input: 404_000 },
    });
    expect(findings[0]).not.toHaveProperty('baseline');
  });

  test('detects a regression from a healthy baseline as a partial read', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(9, warm);
    repeat(3, { read: 20_000, write: 80_000, input: 1000 });
    repeat(5, { read: 20_000, write: 80_000, input: 1000 });
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'persistent']);
    expect(findings[0]).toMatchObject({ type: 'low', reason: 'regression' });
    expect(findings[1]).toMatchObject({ record: { pattern: 'partial' } });
    const { record } = findings[1] as Extract<Finding, { type: 'persistent' }>;
    expect(record.partialShare).toBeCloseTo(0.198, 2);
    const finding = findings[0] as Extract<Finding, { type: 'low' }>;
    expect(finding.baseline).toBeCloseTo(0.95, 2);
    expect(finding.window.share).toBeCloseTo(0.198, 2);
  });

  test('ignores an isolated miss and mild fluctuation', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(9, warm);
    step(miss);
    repeat(5, warm);
    for (let index = 0; index < 10; index += 1)
      step(index % 2 ? warm : { read: 55_000, write: 44_000, input: 1000 });
    expect(findings).toEqual([]);
  });

  test('keeps the baseline through a long failure and reports recovery once', () => {
    const { findings, step, repeat, health } = driver();
    step(cold);
    repeat(9, warm);
    repeat(12, miss);
    expect(health.status('s', opus)).toMatchObject({ kind: 'low' });
    repeat(2, warm);
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'persistent']);
    step(warm);
    repeat(10, warm);
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'persistent', 'recovered']);
    expect(findings[2]).toMatchObject({
      incident: 1,
      notified: true,
      window: { requests: 3 },
      record: { requests: 16, open: false },
    });
    expect(health.status('s', opus)).toMatchObject({ kind: 'ok' });
    repeat(4, miss);
    expect(findings).toHaveLength(4);
    expect(findings[3]).toMatchObject({ type: 'low', reason: 'regression', incident: 2 });
    expect((findings[3] as { baseline: number }).baseline).toBeCloseTo(0.95, 2);
  });

  test('does not recover on mixed results near the warning threshold', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(4, miss);
    for (let index = 0; index < 12; index += 1)
      step(index % 2 ? miss : { read: 40_000, write: 60_000, input: 1000 });
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'persistent']);
  });

  test('counts only later misses toward persistence', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(4, miss);
    step(miss);
    step(warm);
    step(miss);
    expect(findings.map((finding) => finding.type)).toEqual(['low']);
    step(warm);
    expect(findings.map((finding) => finding.type)).toEqual(['low', 'recovered']);
    expect(findings[1]).toMatchObject({ notified: false });
  });

  test('estimates the cached tokens not read and their extra cost', () => {
    const health = createHealth();
    const price = { input: 5, output: 25, read: 0.5, write: 6.25 };
    let clock = 0;
    for (let index = 0; index < 5; index += 1) {
      clock += 30 * SECOND;
      health.observe({
        sessionID: 's',
        stepID: `step-${index}`,
        model: opus,
        started: clock,
        ttl: TTL,
        cachePriced: true,
        price,
        tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 100_000 } },
      });
    }
    const summary = health.summary('s');
    expect(summary).toMatchObject({ incidents: 1, open: 1, lost: 404_000 });
    expect(summary.extra).toBeCloseTo(4 * (0.63 - 0.0505), 4);
    expect(summary.last).toMatchObject({ key: 'anthropic/opus', requests: 4, pattern: 'full' });
    health.compacted('s');
    expect(health.summary('s')).toMatchObject({ incidents: 1, open: 0 });
  });

  test('ignores tiny prompts and windows with too little input', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(10, { write: 5000, input: 1000 });
    repeat(10, { write: 20_000, input: 0 });
    expect(findings).toEqual([]);
  });

  test('resets eligibility after an idle gap longer than the cache lifetime', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(9, warm);
    repeat(8, { ...miss, gap: TTL + SECOND });
    expect(findings).toEqual([]);
  });

  test('resets eligibility and the baseline after compaction', () => {
    const { findings, step, repeat, health } = driver();
    step(cold);
    repeat(9, warm);
    health.compacted('s');
    step(cold);
    repeat(3, miss);
    expect(findings).toEqual([]);
    repeat(4, { read: 25_000, write: 75_000, input: 1000 });
    expect(findings).toEqual([]);
    expect(health.status('s', opus)).toMatchObject({ kind: 'ok' });
  });

  test('keeps the incident window in the status after a reset', () => {
    const { step, repeat, health } = driver();
    step(cold);
    repeat(4, miss);
    step({ ...warm, gap: TTL + SECOND });
    expect(health.status('s', opus)).toMatchObject({
      kind: 'low',
      window: { requests: 4, input: 404_000 },
    });
  });

  test('closes an open incident without a recovery after compaction', () => {
    const { findings, step, repeat, health } = driver();
    step(cold);
    repeat(4, miss);
    health.compacted('s');
    step(cold);
    repeat(5, warm);
    expect(findings.map((finding) => finding.type)).toEqual(['low']);
  });

  test('resets eligibility on model and variant switches', () => {
    const { findings, step } = driver();
    for (let index = 0; index < 12; index += 1)
      step({ ...miss, model: index % 2 ? sol : opus, priced: true });
    for (let index = 0; index < 12; index += 1)
      step({ ...miss, model: { ...opus, variant: index % 2 ? 'high' : 'low' } });
    expect(findings).toEqual([]);
  });

  test('resets eligibility on agent switches and keeps a baseline per agent', () => {
    const { findings, step, repeat, health } = driver();
    step({ ...cold, agent: 'build' });
    repeat(9, { ...warm, agent: 'build' });
    for (let index = 0; index < 12; index += 1)
      step({ ...miss, agent: index % 2 ? 'plan' : 'build' });
    expect(findings).toEqual([]);
    expect(health.status('s', opus, 'build')).toMatchObject({ kind: 'waiting' });
    repeat(4, { ...miss, agent: 'build' });
    expect(findings).toEqual([]);
    step({ ...miss, agent: 'build' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'anthropic/opus@build', reason: 'regression' });
  });

  test('does not borrow continuity or baselines across sessions', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(9, warm);
    step({ ...miss, session: 'other' });
    step(warm);
    repeat(3, { ...miss, session: 'other' });
    expect(findings).toEqual([]);
    step({ ...miss, session: 'other' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'miss' });
  });

  test('treats missing cache telemetry as unknown, not as misses', () => {
    const { findings, repeat, health } = driver();
    repeat(10, { input: 100_000 });
    expect(findings).toEqual([]);
    expect(health.status('s', opus)).toEqual({ kind: 'unknown' });
  });

  test('assumes caching from cache prices when the provider reports none, without escalating', () => {
    const { findings, repeat, health } = driver();
    repeat(5, { input: 100_000, priced: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ reason: 'miss', assumed: true });
    expect(health.status('s', opus)).toMatchObject({ kind: 'low' });
    repeat(10, { input: 100_000, priced: true });
    expect(findings).toHaveLength(1);
    expect(health.summary('s')).toMatchObject({ incidents: 0, open: 0, lost: 0, assumed: 1 });
    expect(health.summary('s').last).toMatchObject({ assumed: true, open: true });
  });

  test('keeps session totals beyond the bounded history', () => {
    const { step, repeat, health } = driver();
    const incidents = THRESHOLDS.history + 1;
    for (let index = 0; index < incidents; index += 1) {
      health.compacted('s');
      step(cold);
      repeat(4, miss);
    }
    expect(health.summary('s')).toMatchObject({
      incidents,
      open: 1,
      lost: incidents * 404_000,
      assumed: 0,
    });
  });

  test('identifies incidents by the start of the request that opened them', () => {
    const { step, repeat, health } = driver();
    step(cold);
    repeat(4, miss);
    expect(health.summary('s').last).toMatchObject({ incident: 1, opened: 150 * SECOND });
  });

  test('ignores invalid values and steps without usage', () => {
    const { findings, step, repeat, health } = driver();
    step(cold);
    repeat(6, { input: 0 });
    repeat(6, { input: Number.NaN, write: 100_000 });
    repeat(6, { input: -1, write: 100_000 });
    expect(findings).toEqual([]);
    expect(health.status('s', opus)).toMatchObject({ kind: 'waiting' });
  });

  test('ignores output and reasoning tokens', () => {
    const heavy = driver();
    const light = driver();
    for (const { step } of [heavy, light]) step(cold);
    heavy.repeat(6, { ...miss, output: 50_000, reasoning: 200_000 });
    light.repeat(6, { ...miss, output: 0 });
    expect(heavy.findings).toEqual(light.findings);
    expect(heavy.findings).toHaveLength(1);
  });

  test('detects healthy reuse without cache writes', () => {
    const { findings, repeat, health } = driver();
    repeat(6, { read: 90_000, input: 10_000 });
    expect(findings).toEqual([]);
    expect(health.status('s', opus)).toMatchObject({ kind: 'ok', window: { share: 0.9 } });
  });

  test('does not warn about writes from normal prefix growth', () => {
    const { findings, step, repeat } = driver();
    step(cold);
    repeat(10, { read: 60_000, write: 40_000, input: 500 });
    expect(findings).toEqual([]);
  });

  test('counts duplicate, late, and failed steps once at most', () => {
    const { findings, step, repeat, health, now } = driver();
    step(cold);
    repeat(2, miss);
    step({ ...miss, id: 'twice' });
    step({ ...miss, id: 'twice' });
    health.failed('s', 'failed');
    step({ ...miss, id: 'failed' });
    expect(findings).toEqual([]);
    const late = health.observe({
      sessionID: 's',
      stepID: 'late',
      model: opus,
      started: now() - 2 * MINUTE,
      ttl: TTL,
      cachePriced: false,
      tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 100_000 } },
    });
    expect(late).toBeUndefined();
    expect(health.status('s', opus)).toMatchObject({ kind: 'waiting' });
    step(miss);
    expect(findings).toHaveLength(1);
  });

  test('bounds the number of tracked sessions', () => {
    const { step, health } = driver();
    for (let index = 0; index <= THRESHOLDS.sessions; index += 1)
      step({ ...warm, session: `s${index}` });
    expect(health.status('s0', opus)).toEqual({ kind: 'unknown' });
    expect(health.status(`s${THRESHOLDS.sessions}`, opus)).toMatchObject({ kind: 'waiting' });
  });

  test('accepts custom thresholds', () => {
    const { findings, step } = driver(createHealth({ ...THRESHOLDS, missRequests: 2 }));
    step(cold);
    step(miss);
    step(miss);
    expect(findings).toHaveLength(1);
  });
});

describe('health messages', () => {
  const window = { share: 0.004, input: 404_000, written: 400_000, requests: 4 };
  const record: IncidentRecord = {
    key: 'anthropic/opus',
    incident: 1,
    opened: 1000,
    assumed: false,
    requests: 7,
    lost: 690_000,
    extra: 3.97,
    pattern: 'full',
    open: true,
    notified: true,
  };

  test('keeps detection and unnotified recoveries silent', () => {
    expect(
      healthTip(
        { type: 'low', key: 'k', incident: 1, reason: 'miss', window, assumed: false },
        'Opus',
      ),
    ).toBeUndefined();
    expect(
      healthTip(
        { type: 'recovered', key: 'k', incident: 1, window, notified: false, record },
        'Opus',
      ),
    ).toBeUndefined();
  });

  test('describes a persistent incident with evidence, cost, and hypotheses', () => {
    const tip = healthTip(
      { type: 'persistent', key: 'anthropic/opus', incident: 1, window, record },
      'Opus',
    );
    expect(tip).toEqual({
      key: 'cache-health:anthropic/opus:1000',
      title: 'Cache reuse still low',
      variant: 'warning',
      attention: true,
      message:
        "Cache reuse is still low for Opus: under 1% of 404K input tokens came from the cache across the last 4 requests. In most of the missed requests, little or nothing was read from the cache. Over 7 requests, an estimated ~690K tokens from earlier prompts weren't read from the cache (~$3.97 extra). Each missed request processes the context again, so compacting makes misses cheaper. Possible causes include prompt-prefix changes, cache configuration, or provider-side misses. Run /cache for details to include in a report.",
    });
  });

  test('describes a partial-read regression', () => {
    const tip = healthTip(
      {
        type: 'persistent',
        key: 'k',
        incident: 2,
        window: { share: 0.2, input: 400_000, written: 0, requests: 4 },
        baseline: 0.95,
        record: {
          ...record,
          opened: 2000,
          pattern: 'partial',
          partialShare: 0.12,
          extra: undefined,
        },
      },
      'Opus',
    );
    expect(tip?.key).toBe('cache-health:k:2000');
    expect(tip?.message).toContain('20% of 400K input tokens');
    expect(tip?.message).toContain('down from 95% earlier in this session');
    expect(tip?.message).toContain('only about 12% of each prompt was read from the cache');
    expect(tip?.message).toContain("weren't read from the cache.");
  });

  test('describes a recovery after a notification', () => {
    expect(
      healthTip(
        {
          type: 'recovered',
          key: 'k',
          incident: 1,
          window: { share: 0.95, input: 300_000, written: 0, requests: 3 },
          notified: true,
          record: { ...record, requests: 9, open: false },
        },
        'Opus',
      ),
    ).toMatchObject({
      key: 'cache-health-recovered:k:1000',
      title: 'Cache reuse recovered',
      variant: 'info',
      message:
        "Cache reuse recovered for Opus: 95% of 300K input tokens came from the cache across the last 3 requests. Over 9 requests, an estimated ~690K tokens from earlier prompts weren't read from the cache (~$3.97 extra).",
    });
  });

  test('summarizes the status and the session incidents for the details view', () => {
    const none = { incidents: 0, open: 0, lost: 0, assumed: 0 };
    expect(healthLines({ kind: 'unknown' }, none)).toEqual([]);
    expect(healthLines({ kind: 'waiting' }, none)).toEqual([
      'Cache health: waiting for more requests on this model',
    ]);
    expect(healthLines({ kind: 'ok', window: { ...window, share: 0.93 } }, none)).toEqual([
      'Cache health: 93% of 404K input tokens read from the cache across the last 4 requests',
    ]);
    expect(
      healthLines(
        { kind: 'low', window, baseline: 0.95 },
        { incidents: 2, open: 1, lost: 1_200_000, extra: 7.1, assumed: 0, last: record },
      ),
    ).toEqual([
      'Cache health: reuse unexpectedly low, under 1% of 404K input tokens read from the cache across the last 4 requests, down from 95%',
      "Cache misses this session: 2 incidents, 1 ongoing. In total, an estimated ~1.2M tokens from earlier prompts weren't read from the cache (~$7.10 extra).",
      'Last incident on anthropic/opus: 7 requests, ongoing. In most of the missed requests, little or nothing was read from the cache.',
    ]);
  });

  test('keeps incidents assumed from prices out of the totals in the details view', () => {
    expect(
      healthLines(
        { kind: 'low', window },
        { incidents: 0, open: 0, lost: 0, assumed: 1, last: { ...record, assumed: true } },
      ),
    ).toEqual([
      'Cache health: reuse unexpectedly low, under 1% of 404K input tokens read from the cache across the last 4 requests',
      'Last incident on anthropic/opus: 7 requests, ongoing, assumed. In most of the missed requests, little or nothing was read from the cache.',
      "1 incident assumed caching from the model's cache prices, because the provider hasn't reported cache use for that model in this session. They may not be real misses, so they aren't in the totals and don't show a warning.",
    ]);
  });
});

test('traces why each step counts or not', () => {
  const skips: string[] = [];
  const { step } = driver(createHealth(THRESHOLDS, (skip) => skips.push(skip)));
  step({ input: 100_000 });
  step({ input: 100_000 });
  step(cold);
  step({ ...warm, id: 'same' });
  step({ ...warm, id: 'same' });
  step({ read: 1000, input: 1000 });
  step({ input: 0 });
  step({ input: Number.NaN });
  step({ ...warm, gap: TTL + SECOND });
  expect(skips).toEqual([
    'reset',
    'telemetry',
    'eligible',
    'eligible',
    'duplicate',
    'small',
    'empty',
    'invalid',
    'reset',
  ]);
});
