import {
  feedbackLinks,
  feedbackTime,
  sessionItems,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import { detailsMessage } from './format';
import { createHash } from 'node:crypto';
import {
  cleanupReadyOf,
  formatCleanupSubtitle,
  worktreeLabel,
  type CleanupCandidate,
  type CleanupScanResult,
} from './session-cleanup';
import type { Snapshot } from './store';

// Server commands, which every client offers, including the web and desktop
// apps that can't run the CLI's dialogs. Their answers are reports that a
// tool-free turn shows, because those apps don't display the text of a
// synthetic message.
// The CLI's own /forge-status and /forge-feedback open dialogs, so these
// take other names rather than appear twice there.
export const STATUS_COMMAND = 'forge-report';
export const FEEDBACK_COMMAND = 'forge-inbox';
export const CLEANUP_COMMAND = 'forge-prune';

export const STATUS_TITLE = 'PR/MR status';
export const FEEDBACK_TITLE = 'Review updates';
export const CLEANUP_TITLE = 'Session cleanup';

// The status dialog's text as Markdown: a paragraph of several lines, such
// as one PR/MR, becomes a bold first line and a list of the rest.
export const statusReport = (snapshot: Snapshot) => {
  const body = detailsMessage(snapshot)
    .split('\n\n')
    .map((paragraph) => {
      const [first, ...rest] = paragraph.split('\n');
      return rest.length ? [`**${first}**`, ...rest.map((line) => `- ${line}`)].join('\n') : first;
    })
    .join('\n\n');
  const ready = cleanupReadyOf(snapshot);
  if (!ready) return body;
  return `${body}\n\n${ready.reason}. Run \`/forge-cleanup\` (or \`/${CLEANUP_COMMAND}\`) to archive this session.`;
};

export type FeedbackAction =
  | { kind: 'list' }
  | { kind: 'acknowledge'; which: string }
  | { kind: 'summarize'; which: string }
  | { kind: 'invalid'; input: string };

const USAGE = `Usage: \`/${FEEDBACK_COMMAND} [ack <id> | ack all | summarize <id>]\``;
export const feedbackRef = (id: string) =>
  createHash('sha256').update(id).digest('hex').slice(0, 16);

export function parseFeedbackAction(input: string): FeedbackAction {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'list' };
  const [verb, argument, ...rest] = words;
  const ref = argument && /^[0-9a-f]{16}$/.test(argument);
  if (rest.length === 0 && (verb === 'ack' || verb === 'acknowledge')) {
    if (argument === 'all') return { kind: 'acknowledge', which: 'all' };
    if (ref) return { kind: 'acknowledge', which: argument };
  }
  if (rest.length === 0 && verb === 'summarize' && ref)
    return { kind: 'summarize', which: argument };
  return { kind: 'invalid', input: input.trim() };
}

function describeItem(item: FeedbackItem, index: number): string[] {
  const facts = [feedbackTime(item)];
  if (item.automation)
    facts.push(
      `${item.automation.state}${item.automation.reason ? `: ${item.automation.reason}` : ''}`,
    );
  return [
    `${index + 1}. ${item.title} (\`${feedbackRef(item.id)}\`)`,
    `   - ${facts.join(' · ')}`,
    ...(item.details ?? []).map((detail) => `   - ${detail}`),
    ...feedbackLinks(item).map((url) => `   - ${url}`),
  ];
}

export function feedbackReport(state: InboxState, sessionID: string, note?: string): string {
  const items = sessionItems(state, sessionID);
  const lines = [
    ...(state.paused ? ['Feedback monitoring is paused.'] : []),
    ...(note ? [note] : []),
  ];
  if (!items.length) return [...lines, 'No pending review updates for this session.'].join('\n\n');
  return [...lines, items.flatMap(describeItem).join('\n'), USAGE].join('\n\n');
}

export const invalidFeedbackReport = (input: string) =>
  [`Forgekeeper did not understand "${input}".`, USAGE].join('\n\n');

export type CleanupAction =
  { kind: 'list' } | { kind: 'clean'; which: string } | { kind: 'invalid'; input: string };

const CLEANUP_USAGE = `Usage: \`/${CLEANUP_COMMAND} [all | <id>]\``;
export const cleanupRef = (sessionID: string) =>
  createHash('sha256').update(sessionID).digest('hex').slice(0, 16);

function extractCleanupTarget(words: readonly string[]): string | undefined {
  if (words.length === 1) return words[0];
  if (words.length === 2 && ['clean', 'archive', 'prune'].includes(words[0])) return words[1];
  return undefined;
}

export function parseCleanupAction(input: string): CleanupAction {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'list' };
  const target = extractCleanupTarget(words);
  if (target === 'all' || (target && /^[0-9a-f]{16}$/.test(target))) {
    return { kind: 'clean', which: target };
  }
  return { kind: 'invalid', input: input.trim() };
}

function describeCandidate(
  candidate: CleanupCandidate,
  index: number,
  multiWorktree: boolean,
): string[] {
  const facts = [
    ...(multiWorktree ? [worktreeLabel(candidate.directory)] : []),
    formatCleanupSubtitle(candidate),
  ];
  return [
    `${index + 1}. ${candidate.title} (\`${cleanupRef(candidate.sessionID)}\`)`,
    `   - ${facts.join(' · ')}`,
    ...candidate.targets.map((target) => `   - ${target.url}`),
  ];
}

function skippedWarning(skippedErrors: number): string[] {
  if (skippedErrors <= 0) return [];
  const suffix = skippedErrors === 1 ? '' : 's';
  return [`Skipped ${skippedErrors} session${suffix} whose target status could not be verified.`];
}

export function cleanupReport(scan: CleanupScanResult, note?: string): string {
  const lines = [...(note ? [note] : []), ...skippedWarning(scan.skippedErrors)];
  if (!scan.candidates.length) {
    return [...lines, 'No sessions with all PRs/MRs merged or tracked issues closed.'].join('\n\n');
  }
  const directories = new Set(scan.candidates.map((candidate) => candidate.directory));
  const multiWorktree = directories.size > 1;
  return [
    ...lines,
    scan.candidates
      .flatMap((candidate, index) => describeCandidate(candidate, index, multiWorktree))
      .join('\n'),
    CLEANUP_USAGE,
  ].join('\n\n');
}

export const invalidCleanupReport = (input: string) =>
  [`Forgekeeper did not understand "${input}".`, CLEANUP_USAGE].join('\n\n');
