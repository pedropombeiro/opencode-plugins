import { describe, expect, test } from 'bun:test';
import { formatCommentBody, formatIssueBody } from './format.ts';
import { sampleInput, sampleMetadata } from './testing.ts';

describe('formatting', () => {
  test('formats structured issue body and comment body with session metadata', () => {
    const issueBody = formatIssueBody(sampleInput, sampleMetadata);
    expect(issueBody).toContain('## Friction');
    expect(issueBody).toContain('## Context');
    expect(issueBody).toContain('## Evidence / Reproduction');
    expect(issueBody).toContain('## Suggested Improvement');
    expect(issueBody).toContain('<details>');
    expect(issueBody).toContain('- **Branch**: `feature/test`');
    expect(issueBody).toContain('- **Session**: `ses_12345`');

    const commentBody = formatCommentBody(sampleInput, sampleMetadata);
    expect(commentBody).toContain('Additional occurrence reported on 2026-11-20.');
    expect(commentBody).toContain('### Context');
  });

  test('escapes standalone GitLab quick-action lines and closes unclosed fences in user text', () => {
    const body = formatIssueBody(
      {
        title: 'Quick action test',
        friction:
          'quoting a command:\n/close\n/label ~bug\r/reopen\n    ```\n/confidential\n    ```',
        context: 'Checking quick action escaping.',
        evidence: '```text\n    ```\n/reopen\n',
        suggestion: 'Use `/close` inline or escape it.',
      },
      sampleMetadata,
    );

    expect(body).toContain('\\/close');
    expect(body).toContain('\\/label ~bug');
    expect(body).toContain('\\/reopen');
    expect(body).toContain('    ```\n\\/confidential\n    ```');
    expect(body).toContain('```text\n    ```\n/reopen\n```');
  });
});
