export interface MetricCounts {
  hit: number;
  found: number;
  pct: number;
}

export interface CoverageEntry {
  lines: MetricCounts;
  functions: MetricCounts;
}

export interface CoverageReport extends CoverageEntry {
  packages: Map<string, CoverageEntry>;
  files: Map<string, CoverageEntry>;
}

export interface MetricComparison {
  base: MetricCounts;
  head: MetricCounts;
  delta: number;
  regressed: boolean;
}

export interface CoverageComparison {
  lines: MetricComparison;
  functions: MetricComparison;
  regressed: boolean;
  regressions: string[];
}

function toPct(hit: number, found: number): number {
  if (found === 0) return 100;
  return Number(((hit / found) * 100).toFixed(2));
}

function createCounts(hit = 0, found = 0): MetricCounts {
  return { hit, found, pct: toPct(hit, found) };
}

function addEntry(target: CoverageEntry, source: CoverageEntry): CoverageEntry {
  const linesHit = target.lines.hit + source.lines.hit;
  const linesFound = target.lines.found + source.lines.found;
  const funcsHit = target.functions.hit + source.functions.hit;
  const funcsFound = target.functions.found + source.functions.found;
  return {
    lines: createCounts(linesHit, linesFound),
    functions: createCounts(funcsHit, funcsFound),
  };
}

function packageNameForPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/^\.\//, '');
  const match = /^packages\/([^/]+)\//.exec(normalized);
  return match ? match[1] : undefined;
}

export function parseLcov(content: string): CoverageReport {
  const files = new Map<string, CoverageEntry>();
  const packages = new Map<string, CoverageEntry>();
  let total: CoverageEntry = {
    lines: createCounts(),
    functions: createCounts(),
  };

  let currentFile: string | undefined;
  let fnf = 0;
  let fnh = 0;
  let lf = 0;
  let lh = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === 'end_of_record') {
      if (currentFile) {
        const entry: CoverageEntry = {
          lines: createCounts(lh, lf),
          functions: createCounts(fnh, fnf),
        };
        const previous = files.get(currentFile);
        files.set(currentFile, previous ? addEntry(previous, entry) : entry);
        total = addEntry(total, entry);
        const pkg = packageNameForPath(currentFile);
        if (pkg) {
          const existingPkg = packages.get(pkg);
          packages.set(pkg, existingPkg ? addEntry(existingPkg, entry) : entry);
        }
      }
      currentFile = undefined;
      fnf = 0;
      fnh = 0;
      lf = 0;
      lh = 0;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);

    switch (key) {
      case 'SF':
        currentFile = value.replace(/^\.\//, '');
        break;
      case 'FNF':
        fnf = Number.parseInt(value, 10) || 0;
        break;
      case 'FNH':
        fnh = Number.parseInt(value, 10) || 0;
        break;
      case 'LF':
        lf = Number.parseInt(value, 10) || 0;
        break;
      case 'LH':
        lh = Number.parseInt(value, 10) || 0;
        break;
    }
  }

  const sortedPackages = new Map(
    [...packages.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const sortedFiles = new Map(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    lines: total.lines,
    functions: total.functions,
    packages: sortedPackages,
    files: sortedFiles,
  };
}

function compareMetric(head: MetricCounts, base: MetricCounts): MetricComparison {
  const delta = Number((head.pct - base.pct).toFixed(2));
  return {
    base,
    head,
    delta,
    regressed: head.pct < base.pct,
  };
}

function formatCounts(counts: MetricCounts): string {
  return `${counts.pct.toFixed(2)}% (${counts.hit}/${counts.found})`;
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta.toFixed(2)}%`;
  return `${delta.toFixed(2)}%`;
}

export function compareCoverage(head: CoverageReport, base: CoverageReport): CoverageComparison {
  const lines = compareMetric(head.lines, base.lines);
  const functions = compareMetric(head.functions, base.functions);
  const regressions: string[] = [];

  if (lines.regressed) {
    regressions.push(
      `Line coverage dropped from ${formatCounts(base.lines)} to ${formatCounts(head.lines)} (${formatDelta(lines.delta)})`,
    );
  }
  if (functions.regressed) {
    regressions.push(
      `Function coverage dropped from ${formatCounts(base.functions)} to ${formatCounts(head.functions)} (${formatDelta(functions.delta)})`,
    );
  }

  return {
    lines,
    functions,
    regressed: regressions.length > 0,
    regressions,
  };
}

function formatPackageComparisonCell(head?: MetricCounts, base?: MetricCounts): string {
  if (!head) return '-';
  if (!base) return formatCounts(head);
  const delta = Number((head.pct - base.pct).toFixed(2));
  return `${base.pct.toFixed(2)}% -> ${head.pct.toFixed(2)}% (${formatDelta(delta)})`;
}

export function formatCoverageSummary(head: CoverageReport, base?: CoverageReport): string {
  const lines: string[] = ['## Test coverage', ''];

  if (base) {
    const comparison = compareCoverage(head, base);
    lines.push(
      '| Metric | Base | Head | Delta | Status |',
      '| --- | ---: | ---: | ---: | --- |',
      `| Lines | ${formatCounts(base.lines)} | ${formatCounts(head.lines)} | ${formatDelta(comparison.lines.delta)} | ${comparison.lines.regressed ? 'Fail' : 'Pass'} |`,
      `| Functions | ${formatCounts(base.functions)} | ${formatCounts(head.functions)} | ${formatDelta(comparison.functions.delta)} | ${comparison.functions.regressed ? 'Fail' : 'Pass'} |`,
    );

    const packageNames = new Set([...base.packages.keys(), ...head.packages.keys()]);
    if (packageNames.size > 0) {
      lines.push(
        '',
        '| Package | Functions | Lines |',
        '| --- | ---: | ---: |',
        ...[...packageNames].sort().map((pkg) => {
          const headPkg = head.packages.get(pkg);
          const basePkg = base.packages.get(pkg);
          return `| \`${pkg}\` | ${formatPackageComparisonCell(headPkg?.functions, basePkg?.functions)} | ${formatPackageComparisonCell(headPkg?.lines, basePkg?.lines)} |`;
        }),
      );
    }
  } else {
    lines.push(
      '| Metric | Covered | Total | Coverage |',
      '| --- | ---: | ---: | ---: |',
      `| Lines | ${head.lines.hit} | ${head.lines.found} | ${head.lines.pct.toFixed(2)}% |`,
      `| Functions | ${head.functions.hit} | ${head.functions.found} | ${head.functions.pct.toFixed(2)}% |`,
    );

    if (head.packages.size > 0) {
      lines.push(
        '',
        '| Package | Functions | Lines |',
        '| --- | ---: | ---: |',
        ...[...head.packages.entries()].map(
          ([pkg, entry]) =>
            `| \`${pkg}\` | ${formatCounts(entry.functions)} | ${formatCounts(entry.lines)} |`,
        ),
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
