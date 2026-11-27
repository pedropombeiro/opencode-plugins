import { appendFileSync } from 'node:fs';
import {
  compareCoverage,
  formatCoverageSummary,
  parseLcov,
} from '../packages/_shared/src/coverage.ts';

const usage = 'Usage: bun .mise/coverage.ts <head-lcov> [base-lcov]';
const [headPath, basePath] = Bun.argv.slice(2);
if (!headPath) throw new Error(usage);

const headReport = parseLcov(await Bun.file(headPath).text());
const baseReport = basePath ? parseLcov(await Bun.file(basePath).text()) : undefined;

const summary = formatCoverageSummary(headReport, baseReport);
process.stdout.write(summary);

const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
if (stepSummaryPath) {
  appendFileSync(stepSummaryPath, `${summary}\n`);
}

if (baseReport) {
  const comparison = compareCoverage(headReport, baseReport);
  if (comparison.regressed) {
    for (const message of comparison.regressions) {
      process.stderr.write(`::error::${message}\n`);
    }
    process.exit(1);
  }
}
