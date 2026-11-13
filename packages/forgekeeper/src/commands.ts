import { feedbackLinks, feedbackTime, type FeedbackItem, type InboxState } from './feedback-inbox';
import { detailsMessage } from './format';
import type { Snapshot } from './store';

// Server commands, which every client offers, including the web and desktop
// apps that can't run the CLI's dialogs. Their answers are reports that a
// tool-free turn shows, because those apps don't display the text of a
// synthetic message.
// The CLI's own /forge-status and /forge-feedback open dialogs, so these
// take other names rather than appear twice there.
export const STATUS_COMMAND = 'forge-report';
export const FEEDBACK_COMMAND = 'forge-inbox';

export const STATUS_TITLE = 'PR/MR status';
export const FEEDBACK_TITLE = 'Review updates';

// The status dialog's text as Markdown: a paragraph of several lines, such
// as one PR/MR, becomes a bold first line and a list of the rest.
export const statusReport = (snapshot: Snapshot) =>
  detailsMessage(snapshot)
    .split('\n\n')
    .map((paragraph) => {
      const [first, ...rest] = paragraph.split('\n');
      return rest.length ? [`**${first}**`, ...rest.map((line) => `- ${line}`)].join('\n') : first;
    })
    .join('\n\n');

export type FeedbackAction =
  | { kind: 'list' }
  | { kind: 'acknowledge'; which: number | 'all' }
  | { kind: 'summarize'; which: number }
  | { kind: 'invalid'; input: string };

const USAGE = `Usage: \`/${FEEDBACK_COMMAND} [ack <number> | ack all | summarize <number>]\``;

// The arguments of `/forge-feedback`: nothing lists the session's updates,
// `ack` acknowledges one or all of them, and `summarize` summarizes one.
export function parseFeedbackAction(input: string): FeedbackAction {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'list' };
  const [verb, argument, ...rest] = words;
  const number = argument && /^[1-9]\d*$/.test(argument) ? Number(argument) : undefined;
  if (rest.length === 0 && (verb === 'ack' || verb === 'acknowledge')) {
    if (argument === 'all') return { kind: 'acknowledge', which: 'all' };
    if (number !== undefined) return { kind: 'acknowledge', which: number };
  }
  if (rest.length === 0 && verb === 'summarize' && number !== undefined)
    return { kind: 'summarize', which: number };
  return { kind: 'invalid', input: input.trim() };
}

// The session's own updates, newest first, as the inbox stores them. Their
// numbers in `/forge-feedback` are positions in this list.
export const sessionItems = (state: InboxState, sessionID: string) =>
  state.items.filter((item) => item.sessionID === sessionID);

function describeItem(item: FeedbackItem, index: number): string[] {
  const facts = [feedbackTime(item)];
  if (item.automation)
    facts.push(
      `${item.automation.state}${item.automation.reason ? `: ${item.automation.reason}` : ''}`,
    );
  return [
    `${index + 1}. ${item.title}`,
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
  return [
    ...lines,
    items.flatMap(describeItem).join('\n'),
    `Acknowledge with \`/${FEEDBACK_COMMAND} ack <number>\` or \`/${FEEDBACK_COMMAND} ack all\`. Summarize one in this session with \`/${FEEDBACK_COMMAND} summarize <number>\`.`,
  ].join('\n\n');
}

export const invalidFeedbackReport = (input: string) =>
  [`Forgekeeper did not understand "${input}".`, USAGE].join('\n\n');
