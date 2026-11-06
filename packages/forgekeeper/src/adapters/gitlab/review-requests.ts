// Reads the requests for the viewer's review from a GitLab MR's system notes.
// GitLab records each request, including a repeated one for a reviewer who
// stays assigned, as a note such as "requested review from @alice and @bob".
import type { ReviewRequestEvent, ReviewRequestHistory } from '../../forge';
import type { GraphQL } from './adapter';
import { query, typed } from '../../graphql';

interface ActivityNode {
  id: string;
  url: string | null;
  body: string;
  createdAt: string;
  system: boolean;
  systemNoteMetadata?: { action: string | null } | null;
  author: { id: string; username: string } | null;
}

const PAGE_SIZE = 100;
// The newest activity notes the plugin reads. A new request is always among
// the newest, so older ones only tell when the previous request was.
export const MAX_ACTIVITY_PAGES = 10;

export const ACTIVITY_QUERY = query<{
  currentUser?: { id: string; username: string } | null;
  project?: {
    mergeRequest?: {
      notes?: {
        pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
        nodes: ActivityNode[];
      } | null;
    } | null;
  } | null;
}>(`query($project: ID!, $iid: String!, $before: String) {
  currentUser { id username }
  project(fullPath: $project) {
    mergeRequest(iid: $iid) {
      notes(last: ${PAGE_SIZE}, before: $before, filter: ONLY_ACTIVITY) {
        pageInfo { hasPreviousPage startCursor }
        nodes { id url body createdAt system systemNoteMetadata { action } author { id username } }
      }
    }
  }
}`);

const REQUESTED = 'requested review from ';
// GitLab joins a reviewer change's parts with " and ", so the requested
// reviewers end where a removal starts.
const REMOVED = /\sand removed (?:review request for|approval)\b/;

// The usernames a reviewer note requests a review from, lowercase. Empty for
// other notes, such as a removed review request.
export function requestedReviewers(body: string): string[] {
  if (!body.startsWith(REQUESTED)) return [];
  const requested = body.slice(REQUESTED.length).split(REMOVED)[0];
  return [...requested.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)].map((match) =>
    match[1].replace(/\.+$/, '').toLowerCase(),
  );
}

const noteNumber = (id: string) => id.slice(id.lastIndexOf('/') + 1);

// The note as a request for `username`'s review, or undefined when it isn't.
export function toRequest(
  node: ActivityNode,
  username: string,
  mergeRequestUrl: string,
): ReviewRequestEvent | undefined {
  const id = noteNumber(node.id);
  const at = Date.parse(node.createdAt);
  const action = node.systemNoteMetadata?.action;
  if (!node.system || (action && action !== 'reviewer')) return undefined;
  if (!/^\d+$/.test(id) || !Number.isFinite(at)) return undefined;
  if (!requestedReviewers(node.body).includes(username.toLowerCase())) return undefined;
  return {
    id,
    order: Number(id),
    url: node.url ?? `${mergeRequestUrl}#note_${id}`,
    at,
    ...(node.author ? { requester: { id: node.author.id, username: node.author.username } } : {}),
  };
}

// Reads the MR's newest activity notes, or undefined when the MR doesn't exist.
export async function fetchReviewRequests(
  transport: GraphQL,
  host: string,
  project: string,
  iid: string,
  mergeRequestUrl: string,
): Promise<ReviewRequestHistory | undefined> {
  const graphql = typed(transport);
  const pages: ActivityNode[][] = [];
  let viewer: { id: string; username: string } | undefined;
  let before: string | undefined;
  const history = (complete: boolean): ReviewRequestHistory => {
    const nodes = pages.toReversed().flat();
    return {
      complete: complete && viewer !== undefined,
      ...(viewer ? { viewerID: viewer.id } : {}),
      newest: nodes.reduce((highest, node) => {
        const id = Number(noteNumber(node.id));
        return Number.isFinite(id) ? Math.max(highest, id) : highest;
      }, 0),
      requests: viewer
        ? nodes
            .flatMap((node) => toRequest(node, viewer!.username, mergeRequestUrl) ?? [])
            .sort((a, b) => a.order - b.order)
        : [],
    };
  };
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const variables: Record<string, string> = { project, iid };
    if (before) variables.before = before;
    const data = await graphql(host, ACTIVITY_QUERY, variables);
    viewer ??= data.currentUser ?? undefined;
    const connection = data.project?.mergeRequest?.notes;
    if (!connection) return page === 0 ? undefined : history(false);
    pages.push(connection.nodes);
    if (!connection.pageInfo.hasPreviousPage) return history(true);
    before = connection.pageInfo.startCursor ?? undefined;
    if (!before) return history(false);
  }
  // A full window is complete: older requests only date the previous one.
  return history(true);
}
