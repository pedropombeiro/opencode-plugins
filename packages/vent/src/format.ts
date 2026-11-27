import type { VentInput, VentMetadata } from './destinations/types.ts';
import { sanitizeRemote } from './options.ts';

function sanitizeMarkdownSection(text: string, options?: { demoteH2?: boolean }): string {
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  const sanitized: string[] = [];
  let fenceChar: '`' | '~' | undefined;
  let fenceLength = 0;

  for (const line of lines) {
    if (fenceChar) {
      if (new RegExp(`^[ ]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`).test(line)) {
        fenceChar = undefined;
        fenceLength = 0;
      }
      sanitized.push(line);
      continue;
    }

    const openFence = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (openFence && (openFence[1]![0] !== '`' || !openFence[2]!.includes('`'))) {
      fenceChar = openFence[1]![0] as '`' | '~';
      fenceLength = openFence[1]!.length;
      sanitized.push(line);
      continue;
    }

    let nextLine = line.replace(/^(\s*)\/(?=[A-Za-z])/, '$1\\/');
    if (options?.demoteH2) {
      nextLine = nextLine.replace(/^([ ]{0,3})##(?=\s)/, '$1###');
    }
    sanitized.push(nextLine);
  }

  if (fenceChar) {
    sanitized.push(fenceChar.repeat(fenceLength));
  }

  return sanitized.join('\n');
}

function formatCodeSpan(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, ' ');
  const backtickRuns = singleLine.match(/`+/g) ?? [];
  const maxRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(maxRun + 1);
  const needsPadding = singleLine.startsWith('`') || singleLine.endsWith('`');
  return needsPadding ? `${fence} ${singleLine} ${fence}` : `${fence}${singleLine}${fence}`;
}

function formatMetadataBlock(metadata: VentMetadata): string {
  const remote = metadata.remote ? sanitizeRemote(metadata.remote) : undefined;
  const rows: string[] = [
    `- **Recorded**: ${metadata.timestamp}`,
    ...(metadata.category ? [`- **Category**: ${formatCodeSpan(metadata.category)}`] : []),
    ...(metadata.directory ? [`- **Directory**: ${formatCodeSpan(metadata.directory)}`] : []),
    ...(remote ? [`- **Repository**: ${formatCodeSpan(remote)}`] : []),
    ...(metadata.branch ? [`- **Branch**: ${formatCodeSpan(metadata.branch)}`] : []),
    ...(metadata.sessionID ? [`- **Session**: ${formatCodeSpan(metadata.sessionID)}`] : []),
  ];

  return ['<details>', '<summary>Session metadata</summary>', '', ...rows, '', '</details>'].join(
    '\n',
  );
}

export function formatIssueBody(input: VentInput, metadata: VentMetadata): string {
  const sections: string[] = [
    '## Friction',
    '',
    sanitizeMarkdownSection(input.friction),
    '',
    '## Context',
    '',
    sanitizeMarkdownSection(input.context),
  ];

  if (input.evidence?.trim()) {
    sections.push('', '## Evidence / Reproduction', '', sanitizeMarkdownSection(input.evidence));
  }

  if (input.suggestion?.trim()) {
    sections.push('', '## Suggested Improvement', '', sanitizeMarkdownSection(input.suggestion));
  }

  sections.push('', formatMetadataBlock(metadata));
  return sections.join('\n');
}

export function formatCommentBody(input: VentInput, metadata: VentMetadata): string {
  const sections: string[] = [
    `Additional occurrence reported on ${metadata.date}.`,
    '',
    '### Friction',
    '',
    sanitizeMarkdownSection(input.friction),
    '',
    '### Context',
    '',
    sanitizeMarkdownSection(input.context),
  ];

  if (input.evidence?.trim()) {
    sections.push('', '### Evidence / Reproduction', '', sanitizeMarkdownSection(input.evidence));
  }

  if (input.suggestion?.trim()) {
    sections.push('', '### Suggested Improvement', '', sanitizeMarkdownSection(input.suggestion));
  }

  sections.push('', formatMetadataBlock(metadata));
  return sections.join('\n');
}

export function formatFileSection(input: VentInput, metadata: VentMetadata): string {
  const title = input.title.replace(/[\r\n]+/g, ' ').trim();
  const sections: string[] = [
    `## ${title}`,
    '',
    '### Friction',
    '',
    sanitizeMarkdownSection(input.friction, { demoteH2: true }),
    '',
    '### Context',
    '',
    sanitizeMarkdownSection(input.context, { demoteH2: true }),
  ];

  if (input.evidence?.trim()) {
    sections.push(
      '',
      '### Evidence / Reproduction',
      '',
      sanitizeMarkdownSection(input.evidence, { demoteH2: true }),
    );
  }

  if (input.suggestion?.trim()) {
    sections.push(
      '',
      '### Suggested Improvement',
      '',
      sanitizeMarkdownSection(input.suggestion, { demoteH2: true }),
    );
  }

  sections.push('', formatMetadataBlock(metadata));
  return sections.join('\n');
}

export function formatFileOccurrence(input: VentInput, metadata: VentMetadata): string {
  const sections: string[] = [
    `### Occurrence (${metadata.date})`,
    '',
    sanitizeMarkdownSection(input.friction, { demoteH2: true }),
    '',
    '#### Context',
    '',
    sanitizeMarkdownSection(input.context, { demoteH2: true }),
  ];

  if (input.evidence?.trim()) {
    sections.push(
      '',
      '#### Evidence / Reproduction',
      '',
      sanitizeMarkdownSection(input.evidence, { demoteH2: true }),
    );
  }

  if (input.suggestion?.trim()) {
    sections.push(
      '',
      '#### Suggested Improvement',
      '',
      sanitizeMarkdownSection(input.suggestion, { demoteH2: true }),
    );
  }

  sections.push('', formatMetadataBlock(metadata));
  return sections.join('\n');
}
