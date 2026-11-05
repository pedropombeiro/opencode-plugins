import type { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
import type { Exec } from './exec';
import { feedbackLinks, feedbackTime, type FeedbackItem, type InboxState } from './feedback-inbox';
import type { CommentDetail, FeedbackTarget, LinkedNote } from './forge';
import { parseUrl, traitsOf } from './forges';
import { createKeyedQueue } from './keyed-queue';
import {
  addLinked,
  findingsText,
  LIFECYCLE_SYSTEM,
  lifecycleText,
  LINKED_NOTE_TOOL,
  linkedContext,
  MAX_FINDINGS,
  MAX_LINK_LENGTH,
  MAX_LINKED_CALLS,
  MAX_LINKED_NOTES,
  MAX_TOTAL,
  MESSAGE_PREFIX,
  messageTag,
  NOTICE_KIND,
  noticeText,
  taggedInput,
  superseded,
  restrictRequest,
  SUMMARY_KIND,
  SUMMARY_PREFIX,
  summarySystem,
  turnInput,
  UNAVAILABLE_TEXT,
  type LinkedResult,
  type LinkedState,
  type SummaryRequest,
} from './review-summary';

const SUMMARY_STORE = 'status/summaries/';
const SUMMARY_RETENTION = 7 * 24 * 60 * 60_000;
export const summaryPrefix = (sessionID: string) =>
  `${SUMMARY_STORE}${encodeURIComponent(sessionID)}/`;
const summaryKey = (sessionID: string, messageID: string) =>
  `${summaryPrefix(sessionID)}${messageID}`;

interface SummaryRecord {
  sessionID: string;
  messageID: string;
  findings: string;
  at: number;
  request?: string;
  linked?: LinkedState;
  system?: 'lifecycle';
}

export interface SummaryDependencies {
  exec: Exec;
  details?: (request: FeedbackTarget, ids: string[]) => Promise<CommentDetail[]>;
  linkedNote?: (request: FeedbackTarget, url: string) => Promise<LinkedNote | undefined>;
  now?: () => number;
}

interface SummaryHost {
  closing: () => boolean;
  inbox: () => Promise<InboxState>;
  deliverable: (item: FeedbackItem) => Promise<boolean>;
  scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
  write: (task: () => Promise<void>) => void;
  report: (error: unknown) => void;
}

const receipt = (note: LinkedResult) =>
  note.status === 'fetched'
    ? `Read ${note.url}. Its text is in the request, in a <linked-note> block.`
    : note.status === 'omitted'
      ? `${note.url} was left out because of size limits.`
      : `Could not read ${note.url}.`;

export const feedbackTarget = (url: string): FeedbackTarget | undefined => {
  const ref = parseUrl(url);
  return ref && { forge: ref.forge, url };
};

export const commentIDsOf = (item: FeedbackItem) => {
  const request = feedbackTarget(item.url);
  const capability = request && traitsOf(request).feedback;
  return item.commentIDs ?? item.links.flatMap((link) => capability?.commentID?.(link) ?? []);
};

export function createSummaryDelivery(
  ctx: Plugin.Context,
  deps: SummaryDependencies,
  host: SummaryHost,
) {
  const directory = ctx.location.directory;
  const now = deps.now ?? Date.now;
  const summaries = new Map<string, Set<string>>();
  const requesting = new Map<string, string | undefined>();
  const queue = createKeyedQueue();
  const track = (sessionID: string, messageID: string) =>
    summaries.set(sessionID, (summaries.get(sessionID) ?? new Set()).add(messageID));
  let restoring: Promise<void> | undefined;
  const restore = () =>
    (restoring ??= host.scan(SUMMARY_STORE).then(
      (entries) => {
        for (const { value } of entries) {
          const record = value as SummaryRecord;
          track(record.sessionID, record.messageID);
        }
      },
      (error) => {
        restoring = undefined;
        host.report(error);
      },
    ));
  void restore();

  const readRecord = async (sessionID: string, messageID: string) => {
    const record = (await ctx.storage
      .get(summaryKey(sessionID, messageID))
      .catch(() => undefined)) as SummaryRecord | undefined;
    return record && now() - record.at < SUMMARY_RETENTION ? record : undefined;
  };

  async function summaryTurn(sessionID: string): Promise<SummaryRecord | 'failed' | undefined> {
    await restore();
    const pending = summaries.get(sessionID);
    if (!pending?.size) return undefined;
    let messages;
    try {
      messages = await ctx.session.context({ sessionID });
    } catch {
      return 'failed';
    }
    for (const messageID of [...pending]) {
      if (!superseded(messages, messageID)) continue;
      pending.delete(messageID);
      host.write(() => ctx.storage.remove(summaryKey(sessionID, messageID)));
    }
    const input = turnInput(messages);
    if (!pending.size) summaries.delete(sessionID);
    if (!input) return pending.size ? 'failed' : undefined;
    if (input.type === 'user') return undefined;
    return (await readRecord(sessionID, input.id)) ?? 'failed';
  }

  async function userInput(sessionID: string): Promise<boolean> {
    try {
      return turnInput(await ctx.session.context({ sessionID }))?.type === 'user';
    } catch {
      return false;
    }
  }

  async function deliver(item: FeedbackItem, requested = false): Promise<boolean> {
    const mode = requested ? 'summary' : item.delivery;
    if (!mode) return false;
    if (!(await host.deliverable(item))) return false;
    const hash = createHash('sha256')
      .update(requested ? `${item.id} ${now()}` : item.id)
      .digest('hex');
    const links = feedbackLinks(item);
    const request = feedbackTarget(item.url);
    const reader = request && traitsOf(request).feedback?.details;
    const details =
      deps.details ??
      (reader &&
        ((target: FeedbackTarget, ids: string[]) => reader(deps.exec, directory, target, ids)));
    const commentIDs = commentIDsOf(item);
    const event = item.kind;
    const review = mode === 'summary' && !event && request && details && commentIDs.length;
    const summary = (mode === 'summary' && !!event) || !!review;
    if (requested && !summary)
      throw new Error('This update has no comments that can be summarized');
    const messageID = `${summary ? SUMMARY_PREFIX : MESSAGE_PREFIX}${hash}`;
    const described = `${item.title} (${feedbackTime(item)})`;
    const read = review ? await details(request, commentIDs.slice(0, MAX_FINDINGS * 2)) : [];
    const findings =
      summary && event
        ? lifecycleText({ ...item, kind: event }, feedbackTime(item))
        : review
          ? findingsText(described, item.url, read)
          : noticeText(described, links);
    const allowed = review
      ? (
          traitsOf(request).feedback?.linkedNotes?.(
            request,
            read.filter((detail) => detail.url.startsWith(`${item.url}#`)),
          ) ?? []
        )
          .filter((url) => url.length <= MAX_LINK_LENGTH)
          .slice(0, MAX_LINKED_NOTES)
      : [];
    if (!(await host.deliverable(item))) return false;
    const state = await host.inbox();
    if (state.paused) throw new Error('Feedback monitoring is paused');
    if (!state.items.some((entry) => entry.id === item.id)) return false;
    const record: SummaryRecord = {
      sessionID: item.sessionID,
      messageID,
      findings,
      at: now(),
      ...(allowed.length
        ? { request: item.url, linked: { links: allowed, calls: 0, notes: [] } }
        : {}),
      ...(event ? { system: 'lifecycle' as const } : {}),
    };
    await ctx.storage.set(summaryKey(item.sessionID, messageID), record as never);
    track(item.sessionID, messageID);
    if (host.closing()) throw new Error('The plugin stopped');
    await ctx.session.synthetic({
      sessionID: item.sessionID,
      id: messageID,
      text: [
        item.title,
        feedbackTime(item),
        ...links,
        ...(event && item.details?.length ? [item.details.join('\n')] : []),
        summary
          ? event
            ? 'Forgekeeper summarizes this merge request change without tools.'
            : allowed.length
              ? 'Forgekeeper summarizes this review feedback. It can read only the notes these comments link to.'
              : 'Forgekeeper summarizes this review feedback without tools.'
          : event
            ? 'Merge request update only. No action requested.'
            : 'Review update only. No action requested.',
        messageTag(messageID),
      ].join('\n\n'),
      description: item.title,
      metadata: { forgekeeper: summary ? SUMMARY_KIND : NOTICE_KIND },
      delivery: 'queue',
      resume: !!summary,
    });
    return true;
  }

  async function fetchLinked(sessionID: string, input: unknown): Promise<string> {
    const refuse = () =>
      new Error(`${LINKED_NOTE_TOOL} works only while Forgekeeper summarizes review feedback.`);
    const messageID = requesting.get(sessionID);
    if (!messageID) throw refuse();
    const url = typeof input === 'string' ? input.trim() : '';
    const key = summaryKey(sessionID, messageID);
    const store = async (record: SummaryRecord) => {
      if (host.closing()) throw new Error('The plugin stopped');
      await ctx.storage.set(key, record as never);
    };
    return queue.run(key, async () => {
      if (host.closing()) throw new Error('The plugin stopped');
      const current = await summaryTurn(sessionID);
      if (current === undefined || current === 'failed' || current.messageID !== messageID)
        throw refuse();
      const record = current;
      const linked = record.linked;
      if (!record.request || !linked) throw new Error('This summary has no linked notes to read.');
      if (linked.calls >= MAX_LINKED_CALLS)
        throw new Error('The linked-note call limit is reached. Summarize with what you have.');
      const spent: SummaryRecord = { ...record, linked: { ...linked, calls: linked.calls + 1 } };
      await store(spent);
      if (!linked.links.includes(url))
        throw new Error('Only the links the request lists as readable can be read.');
      const known = linked.notes.find((note) => note.url === url);
      if (known) return receipt(known);
      const request = feedbackTarget(record.request);
      const reader =
        deps.linkedNote ??
        ((target: FeedbackTarget, link: string) =>
          traitsOf(target).feedback?.linkedNote?.(deps.exec, directory, target, link) ??
          Promise.resolve(undefined));
      const note = request ? await reader(request, url).catch(() => undefined) : undefined;
      if (!(await readRecord(sessionID, messageID))) throw new Error('The summary ended.');
      const next: SummaryRecord = { ...spent, linked: addLinked(spent.linked!, url, note) };
      await store(next);
      return receipt(next.linked!.notes.find((entry) => entry.url === url)!);
    });
  }

  return {
    deliver,
    fetchLinked,
    async prepare(event: SummaryRequest): Promise<boolean> {
      const tagged = taggedInput(event.messages);
      let record = await summaryTurn(event.sessionID);
      if (!record && tagged && !(await userInput(event.sessionID)))
        record = (await readRecord(event.sessionID, tagged)) ?? 'failed';
      if (!record) {
        requesting.delete(event.sessionID);
        return false;
      }
      requesting.set(event.sessionID, record === 'failed' ? undefined : record.messageID);
      const linked =
        record === 'failed' || !record.linked
          ? undefined
          : linkedContext(record.linked, MAX_TOTAL - record.findings.length - 2);
      const tool = linked?.tool ? event.tools[LINKED_NOTE_TOOL] : undefined;
      restrictRequest(
        event,
        record !== 'failed' && record.system === 'lifecycle'
          ? LIFECYCLE_SYSTEM
          : summarySystem(!!tool, !!linked),
        record === 'failed'
          ? UNAVAILABLE_TEXT
          : [record.findings, linked?.text ?? ''].filter(Boolean).join('\n\n'),
        tool ? { name: LINKED_NOTE_TOOL, value: tool } : undefined,
      );
      return true;
    },
    async summarizing(sessionID: string): Promise<boolean> {
      return requesting.has(sessionID) || (await summaryTurn(sessionID)) !== undefined;
    },
    async prune() {
      const at = now();
      for (const { key, value } of await host.scan(SUMMARY_STORE)) {
        const record = value as SummaryRecord;
        if (at - record.at < SUMMARY_RETENTION) continue;
        await ctx.storage.remove(key);
        summaries.get(record.sessionID)?.delete(record.messageID);
      }
    },
  };
}
