import type { VentInput, VentMetadata } from './destinations/types.ts';
import { sanitizeRemote } from './options.ts';

function sanitizeMarkdownSection(text: string): string {
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

    sanitized.push(line.replace(/^(\s*)\/(?=[A-Za-z])/, '$1\\/'));
  }

  if (fenceChar) {
    sanitized.push(fenceChar.repeat(fenceLength));
  }

  return sanitized.join('\n');
}

function formatMetadataBlock(metadata: VentMetadata): string {
  const remote = metadata.remote ? sanitizeRemote(metadata.remote) : undefined;
  const rows: string[] = [
    `- **Recorded**: ${metadata.timestamp}`,
    ...(metadata.category ? [`- **Category**: \`${metadata.category}\``] : []),
    ...(metadata.directory ? [`- **Directory**: \`${metadata.directory}\``] : []),
    ...(remote ? [`- **Repository**: \`${remote}\``] : []),
    ...(metadata.branch ? [`- **Branch**: \`${metadata.branch}\``] : []),
    ...(metadata.sessionID ? [`- **Session**: \`${metadata.sessionID}\``] : []),
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
  const sections: string[] = [
    `## ${input.title.trim()}`,
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

export function formatFileOccurrence(input: VentInput, metadata: VentMetadata): string {
  const sections: string[] = [
    `### Occurrence (${metadata.date})`,
    '',
    sanitizeMarkdownSection(input.friction),
    '',
    `**Context**: ${sanitizeMarkdownSection(input.context)}`,
  ];

  if (input.evidence?.trim()) {
    sections.push('', `**Evidence**: ${sanitizeMarkdownSection(input.evidence)}`);
  }

  if (input.suggestion?.trim()) {
    sections.push('', `**Suggested improvement**: ${sanitizeMarkdownSection(input.suggestion)}`);
  }

  sections.push('', formatMetadataBlock(metadata));
  return sections.join('\n');
}
