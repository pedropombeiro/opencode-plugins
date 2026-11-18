// The protocol between an owning session and the linked session that runs
// its turn in a worktree: how a linked session is marked, how the instances
// of the two checkouts announce themselves, and the placeholder that stands
// in for the task in the linked session's transcript.
import { isJobFailure } from './job-investigation';
import type { AutomationRule } from './options';
import type { AutomationRecord } from './review-automation';
import { messageTag } from './review-summary';

// A session as the checks of a checkout's sessions read it.
export interface DirectorySession {
  id: string;
  parentID?: string;
  fork?: unknown;
  metadata?: Record<string, unknown>;
  time: { busy?: number; idle?: number; archived?: number };
}

// Whether the session's turn is running: it became busy after it was last idle.
export const isBusy = (session: DirectorySession) =>
  session.time.busy !== undefined &&
  (session.time.idle === undefined || session.time.busy > session.time.idle);

// The session that a linked session works for, or undefined for any other
// session. A fork copies its source's metadata, so the metadata names the
// session it belongs to once Forgekeeper knows its ID.
export function linkedOwner(session: DirectorySession): string | undefined {
  const value = session.metadata?.forgekeeper;
  const linked =
    value && typeof value === 'object'
      ? (value as { linked?: { owner?: unknown; session?: unknown } }).linked
      : undefined;
  if (!linked || typeof linked.owner !== 'string') return undefined;
  if (typeof linked.session === 'string' ? linked.session !== session.id : !!session.fork)
    return undefined;
  return linked.owner;
}

export const linkedMetadata = (owner: string, batch: string, session?: string) => ({
  forgekeeper: { linked: { owner, batch, ...(session ? { session } : {}) } },
});

// The instances that can run a linked session's turn announce themselves,
// so a turn never reaches a worktree whose Forgekeeper isn't running, and
// with their rules, so a worktree's instance checks a linked turn under the
// rules of the instance that owns it.
export const PRESENCE_INTERVAL = 60_000;
export const presenceKey = (directory: string) =>
  `automation-hosts/${encodeURIComponent(directory)}`;

export interface Presence {
  at: number;
  instance: string;
  rules: readonly AutomationRule[];
}

// The announcement, while it's recent enough that the instance still runs.
export function freshPresence(value: unknown, now: number): Presence | undefined {
  const presence = value as Partial<Presence> | undefined;
  if (typeof presence?.at !== 'number' || now - presence.at > 2 * PRESENCE_INTERVAL)
    return undefined;
  return Array.isArray(presence.rules) ? (presence as Presence) : undefined;
}

const LINKED_TAG = /\[forgekeeper:(msg_forgekeeper_prepare_[0-9a-f]{64}_[1-9]\d*)\]/;

// What the linked session's prompt shows instead of the task, which only
// Forgekeeper adds to its requests. Without Forgekeeper there, such as when
// it's disabled, the model never reads the findings.
export const linkedPlaceholder = (record: AutomationRecord) =>
  [
    `Forgekeeper ${isJobFailure(record.item) ? 'failed-job investigation' : 'review preparation'} task for ${record.item.url}.`,
    "Forgekeeper adds the task to this request. If this message is all you can read, Forgekeeper isn't running in this worktree: reply that the task couldn't start, and change nothing.",
    messageTag(record.messageID!),
  ].join('\n\n');

// The message ID that a placeholder names, if the text holds one.
export const placeholderMessageID = (text: string) => text.match(LINKED_TAG)?.[1];
