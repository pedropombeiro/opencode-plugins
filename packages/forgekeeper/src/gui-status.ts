import type { ComposerPillTone, ComposerPillView } from '@opencode/plugin/gui';
import { footerSegments, type Segment, type Tone } from './format';
import type { Snapshot } from './store';

export function statusPill(
  snapshot: Snapshot,
  updates: string | undefined,
  actions: { external(url: string): void; status(): void; feedback(): void },
): ComposerPillView | undefined {
  const segments = footerSegments(snapshot);
  if (!segments.length && !updates) return undefined;
  const firstStatus = segments.findIndex((segment) => !segment.essential || !segment.url);
  const referenceCount = firstStatus < 0 ? segments.length : Math.max(1, firstStatus);
  const pending =
    snapshot.lookup?.kind === 'found' && snapshot.lookup.requests.length === 1
      ? snapshot.lookup.requests[0].awaitingReviewers
      : undefined;
  return {
    icon: 'review',
    label: [
      ...segments
        .map((segment, index) => ({
          segment,
          priority: index < referenceCount ? -1 : priority(segment),
        }))
        .sort((a, b) => a.priority - b.priority)
        .map(({ segment }) => compactLabel(segment, pending)),
      updates?.replace(/^(\d+) review updates?/, '↻ $1'),
    ]
      .filter(Boolean)
      .join(' · '),
    tone: pillTone(segments.map((segment) => segment.tone)),
    title: 'PR/MR status',
    rows: [
      ...segments.map((segment, index) => ({
        id: `segment-${index}`,
        label:
          segment.text.startsWith('awaiting ') && pending?.length
            ? `awaiting ${pending.map((username) => `@${username}`).join(', ')}`
            : segment.text,
        ...(segment.url ? { icon: 'outline-arrow-up-right' as const } : {}),
        ...(segment.tone === 'success' || segment.tone === 'warning'
          ? { tone: segment.tone }
          : segment.tone === 'error'
            ? { tone: 'danger' as const }
            : {}),
        ...(segment.url ? { run: () => actions.external(segment.url!) } : {}),
      })),
      {
        id: 'details',
        label: 'Show PR/MR status',
        icon: 'status',
        run: actions.status,
      },
      ...(updates
        ? [
            {
              id: 'feedback',
              label: updates,
              icon: 'comment' as const,
              run: actions.feedback,
            },
          ]
        : []),
    ],
  };
}

function priority(segment: Segment): number {
  if (segment.text === 'mergeability unknown') return 4;
  if (segment.tone === 'error') return 0;
  if (/unresolved threads?$/.test(segment.text)) return 1;
  if (segment.tone === 'warning') return 2;
  return 3;
}

function compactLabel(segment: Segment, pending?: readonly string[]): string {
  const threads = segment.text.match(/^(\d+\+?) unresolved threads?$/);
  if (threads) return `💬 ${threads[1]}`;
  if (segment.text.startsWith('awaiting ') && pending?.length)
    return `◷ @${pending[0]}${pending.length > 1 ? ` +${pending.length - 1}` : ''}`;
  if (segment.text === 'approved') return '✓ approved';
  if (segment.compact?.startsWith('CI ')) return segment.compact.replace(/^CI ([✓✗…])/, '$1 CI');
  return segment.compact ?? segment.text;
}

function pillTone(tones: readonly Tone[]): ComposerPillTone | undefined {
  if (tones.includes('error')) return 'danger';
  if (tones.includes('warning')) return 'warning';
  if (tones.includes('success')) return 'success';
  return undefined;
}
