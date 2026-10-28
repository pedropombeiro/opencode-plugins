// Reads a GitLab MR's comments for GitLab's `feedback` capability.
import type { FeedbackSnapshot, ReviewComment } from '../../forge';
import type { GraphQL } from './adapter';
import { query, typed, type Query } from '../../graphql';

interface NoteNode {
  id: string;
  url: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastEditedAt: string | null;
  system: boolean;
  position?: { newPath: string | null } | null;
  duoCreatedSession?: { id: string; status: string; workflowDefinition: string | null } | null;
  discussion: { resolved: boolean } | null;
  author: { id: string; username: string; bot: boolean } | null;
}

const PAGE_SIZE = 100;
// The newest comments the plugin reads. New comments and replies are always
// the newest, so older ones only matter as activity.
export const MAX_COMMENT_PAGES = 20;

// ONLY_COMMENTS leaves out system notes such as "added 1 commit". Pages run
// backwards from the newest comment, in creation order within each page.
export const COMMENTS_QUERY = query<{
  currentUser?: { id: string } | null;
  project?: {
    mergeRequest?: {
      notes?: {
        pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
        nodes: NoteNode[];
      } | null;
    } | null;
  } | null;
}>(`query($project: ID!, $iid: String!, $before: String) {
  currentUser { id }
  project(fullPath: $project) {
    mergeRequest(iid: $iid) {
      notes(last: ${PAGE_SIZE}, before: $before, filter: ONLY_COMMENTS) {
        pageInfo { hasPreviousPage startCursor }
        nodes {
          id url createdAt updatedAt lastEditedAt system
          position { newPath }
          discussion { resolved }
          author { id username bot }
        }
      }
    }
  }
}`);

type CommentData = typeof COMMENTS_QUERY extends Query<infer Data> ? Data : never;
export const DUO_COMMENTS_QUERY = query<CommentData>(
  String(COMMENTS_QUERY).replace(
    'position { newPath }',
    'position { newPath } duoCreatedSession { id status workflowDefinition }',
  ),
);

// GitLab's global ID prefix changes with the note's type, for example when a
// reply turns a comment into a discussion, so only the number identifies it.
const noteNumber = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const timestamp = (node: NoteNode) =>
  Date.parse(node.lastEditedAt ?? node.updatedAt ?? node.createdAt);

// Converts a note to a comment. System notes aren't comments, and the query
// already excludes them, so any that slip through are skipped too.
export function toComment(node: NoteNode): ReviewComment | undefined {
  const editedAt = timestamp(node);
  const id = noteNumber(node.id);
  if (node.system || !node.author || !Number.isFinite(editedAt) || !/^\d+$/.test(id))
    return undefined;
  return {
    id,
    // All notes on an MR share one ID sequence, so a later note has a higher ID.
    order: Number(id),
    url: node.url ?? '',
    editedAt,
    resolved: node.discussion?.resolved === true,
    bot: node.author.bot,
    authorID: node.author.id,
    username: node.author.username,
    ...(node.author.bot && node.author.username.toLowerCase() === 'gitlabduo'
      ? {
          automated: {
            reviewer: 'GitLab Duo',
            finding: !!node.position,
            ...(node.duoCreatedSession?.workflowDefinition === 'code_review/v1'
              ? {
                  runID: node.duoCreatedSession.id,
                  status: node.duoCreatedSession.status,
                }
              : {}),
          },
        }
      : {}),
  };
}

// Reads the MR's newest comments, oldest first, or undefined when the MR
// doesn't exist.
export async function fetchComments(
  transport: GraphQL,
  host: string,
  project: string,
  iid: string,
): Promise<FeedbackSnapshot | undefined> {
  const graphql = typed(transport);
  const pages: ReviewComment[][] = [];
  let viewerID: string | undefined;
  let before: string | undefined;
  let workflowFields = true;
  const snapshot = (complete: boolean): FeedbackSnapshot => ({
    // Without the viewer's ID, their own comments can't be told apart.
    complete: complete && viewerID !== undefined,
    viewerID,
    comments: pages.toReversed().flat(),
  });
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const variables: Record<string, string> = { project, iid };
    if (before) variables.before = before;
    let data;
    try {
      data = await graphql(host, workflowFields ? DUO_COMMENTS_QUERY : COMMENTS_QUERY, variables);
    } catch (error) {
      if (
        !workflowFields ||
        !/duoCreatedSession.*(?:doesn't exist|not defined|unknown)|(?:undefinedField|unknown field).*duoCreatedSession/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      workflowFields = false;
      data = await graphql(host, COMMENTS_QUERY, variables);
    }
    viewerID ??= data.currentUser?.id ?? undefined;
    const connection = data.project?.mergeRequest?.notes;
    if (!connection) return page === 0 ? undefined : snapshot(false);
    pages.push(connection.nodes.flatMap((node) => toComment(node) ?? []));
    if (!connection.pageInfo.hasPreviousPage) return snapshot(true);
    before = connection.pageInfo.startCursor ?? undefined;
    if (!before) return snapshot(false);
  }
  // A full window is complete: anything older is outside what the plugin watches.
  return snapshot(true);
}
