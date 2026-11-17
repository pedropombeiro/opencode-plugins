import { expect, test } from 'bun:test';

// Fails on purpose, so Forgekeeper's failed-job automation has a job to investigate.
test('forgekeeper worktree live check', () => {
  expect('investigate me again').toBe('passing');
});
