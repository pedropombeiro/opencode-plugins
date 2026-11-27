import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, sampleInput, sampleMetadata } from '../testing.ts';
import { parseMarkdownSections, ventToFile } from './file.ts';
import type { VentInput } from './types.ts';

describe('file destination', () => {
  test('creates the file, appends new sections, and appends occurrences under matching sections', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'docs', 'vents.md');

    const first = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      sampleInput,
      sampleMetadata,
      { threshold: 0.45 },
    );
    expect(first.action).toBe('created');

    const secondInput: VentInput = {
      title: 'Docker daemon stalls after macOS sleep',
      friction: 'Colima socket stops responding until restarted after wake from sleep.',
      context: 'Running container builds after reopening the laptop.',
    };
    const second = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      secondInput,
      sampleMetadata,
      { threshold: 0.45 },
    );
    expect(second.action).toBe('created');

    const recurring = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      {
        title: 'Approval prompt on `glab api` pagination flag',
        friction: 'Another `glab api --paginate` GET call prompted for approval.',
        context: 'Checking merge requests across projects.',
      },
      {
        ...sampleMetadata,
        date: '2026-11-21',
        timestamp: '2026-11-21T09:00:00.000Z',
      },
      { threshold: 0.45 },
    );
    expect(recurring.action).toBe('commented');
    expect(recurring.matchedTitle).toBe(sampleInput.title);

    const content = await readFile(targetPath, 'utf8');
    const sections = parseMarkdownSections(content);
    expect(sections.map((section) => section.title)).toEqual([
      sampleInput.title,
      secondInput.title,
    ]);
    expect(sections[0]!.body).toContain('### Occurrence (2026-11-21)');
    expect(sections[1]!.body).not.toContain('### Occurrence (2026-11-21)');
  });

  test('ignores ## headings inside fenced code blocks', () => {
    const markdown = [
      '# Agent Vents',
      '',
      '## Real section',
      '',
      '```markdown',
      '## Not a section',
      '```',
      '',
      '## Second section',
      '',
      'Body text',
    ].join('\n');

    expect(parseMarkdownSections(markdown).map((s) => s.title)).toEqual([
      'Real section',
      'Second section',
    ]);
  });

  test('serializes concurrent writes to the same file without losing entries', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'concurrent.md');

    await Promise.all([
      ventToFile(
        'local',
        { type: 'file', path: targetPath },
        {
          title: 'First concurrent friction',
          friction: 'The first tool failed during setup.',
          context: 'Testing concurrent write safety.',
        },
        sampleMetadata,
        { threshold: 0.45 },
      ),
      ventToFile(
        'local',
        { type: 'file', path: targetPath },
        {
          title: 'Second unrelated timeout issue',
          friction: 'Database query timed out on large table scan.',
          context: 'Running analytics benchmarks.',
        },
        sampleMetadata,
        { threshold: 0.45 },
      ),
    ]);

    const content = await readFile(targetPath, 'utf8');
    const sections = parseMarkdownSections(content);
    expect(sections.map((section) => section.title)).toEqual([
      'First concurrent friction',
      'Second unrelated timeout issue',
    ]);
  });

  test('ignores triple-backtick lines and headings inside a four-backtick fence and respects AbortSignal', async () => {
    const markdown = [
      '# Agent vents',
      '',
      '## Real section',
      '',
      '````markdown',
      '```',
      '## Heading inside nested fence',
      '```',
      '````',
      '',
      '## Second real section',
      '',
      'Body text.',
    ].join('\n');

    const sections = parseMarkdownSections(markdown);
    expect(sections.map((section) => section.title)).toEqual([
      'Real section',
      'Second real section',
    ]);

    const dir = await makeTempDir();
    const targetPath = join(dir, 'aborted.md');
    const controller = new AbortController();
    controller.abort();

    await expect(
      ventToFile('local', { type: 'file', path: targetPath }, sampleInput, sampleMetadata, {
        threshold: 0.45,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(targetPath).exists()).toBe(false);
  });
});
