import { describe, expect, test } from 'bun:test';
import { compareCoverage, formatCoverageSummary, parseLcov } from './coverage.ts';

const baseLcov = [
  'TN:',
  'SF:./packages/alpha/src/index.ts',
  'FNF:4',
  'FNH:4',
  'LF:20',
  'LH:19',
  'end_of_record',
  'TN:',
  'SF:packages/beta/src/index.ts',
  'FNF:6',
  'FNH:5',
  'LF:30',
  'LH:27',
  'end_of_record',
].join('\n');

describe('parseLcov', () => {
  test('aggregates total, per-package, and per-file coverage counts', () => {
    const report = parseLcov(baseLcov);
    expect(report.lines).toEqual({ hit: 46, found: 50, pct: 92 });
    expect(report.functions).toEqual({ hit: 9, found: 10, pct: 90 });
    expect([...report.packages.keys()]).toEqual(['alpha', 'beta']);
    expect(report.packages.get('alpha')).toEqual({
      lines: { hit: 19, found: 20, pct: 95 },
      functions: { hit: 4, found: 4, pct: 100 },
    });
    expect(report.files.get('packages/alpha/src/index.ts')?.lines.pct).toBe(95);
  });

  test('handles empty input and duplicate records for the same file', () => {
    const empty = parseLcov('');
    expect(empty.lines).toEqual({ hit: 0, found: 0, pct: 100 });
    expect(empty.functions).toEqual({ hit: 0, found: 0, pct: 100 });

    const duplicate = parseLcov(
      [
        'SF:src/standalone.ts',
        'FNF:1',
        'FNH:1',
        'LF:2',
        'LH:1',
        'end_of_record',
        'SF:src/standalone.ts',
        'FNF:1',
        'FNH:1',
        'LF:2',
        'LH:2',
        'end_of_record',
      ].join('\n'),
    );
    expect(duplicate.lines).toEqual({ hit: 3, found: 4, pct: 75 });
    expect(duplicate.packages.size).toBe(0);
  });
});

describe('compareCoverage', () => {
  test('passes when line and function coverage stay flat or improve', () => {
    const base = parseLcov(baseLcov);
    const head = parseLcov(
      [
        'SF:packages/alpha/src/index.ts',
        'FNF:4',
        'FNH:4',
        'LF:20',
        'LH:20',
        'end_of_record',
        'SF:packages/beta/src/index.ts',
        'FNF:6',
        'FNH:5',
        'LF:30',
        'LH:27',
        'end_of_record',
      ].join('\n'),
    );
    const comparison = compareCoverage(head, base);
    expect(comparison.regressed).toBe(false);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.lines.delta).toBe(2);
    expect(comparison.functions.delta).toBe(0);
  });

  test('reports regressions when line or function coverage drops', () => {
    const base = parseLcov(baseLcov);
    const head = parseLcov(
      [
        'SF:packages/alpha/src/index.ts',
        'FNF:4',
        'FNH:3',
        'LF:20',
        'LH:18',
        'end_of_record',
        'SF:packages/beta/src/index.ts',
        'FNF:6',
        'FNH:5',
        'LF:30',
        'LH:27',
        'end_of_record',
      ].join('\n'),
    );
    const comparison = compareCoverage(head, base);
    expect(comparison.regressed).toBe(true);
    expect(comparison.lines.regressed).toBe(true);
    expect(comparison.functions.regressed).toBe(true);
    expect(comparison.regressions).toEqual([
      'Line coverage dropped from 92.00% (46/50) to 90.00% (45/50) (-2.00%)',
      'Function coverage dropped from 90.00% (9/10) to 80.00% (8/10) (-10.00%)',
    ]);
  });
});

describe('formatCoverageSummary', () => {
  test('formats standalone and base-compared markdown tables', () => {
    const base = parseLcov(baseLcov);
    const standalone = formatCoverageSummary(base);
    expect(standalone).toContain('| Lines | 46 | 50 | 92.00% |');
    expect(standalone).toContain('| `alpha` | 100.00% (4/4) | 95.00% (19/20) |');

    const head = parseLcov(
      [
        ...baseLcov.split('\n'),
        'SF:packages/gamma/src/index.ts',
        'FNF:2',
        'FNH:2',
        'LF:10',
        'LH:10',
        'end_of_record',
      ].join('\n'),
    );
    const compared = formatCoverageSummary(head, base);
    expect(compared).toContain('| Lines | 92.00% (46/50) | 93.33% (56/60) | +1.33% | Pass |');
    expect(compared).toContain('| `gamma` | 100.00% (2/2) | 100.00% (10/10) |');

    const removedPkg = formatCoverageSummary(
      parseLcov(
        [
          'SF:packages/alpha/src/index.ts',
          'FNF:4',
          'FNH:4',
          'LF:20',
          'LH:19',
          'end_of_record',
        ].join('\n'),
      ),
      base,
    );
    expect(removedPkg).toContain('| `beta` | - | - |');
  });
});
