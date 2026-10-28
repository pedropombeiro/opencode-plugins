// Reads a GitLab MR's comments for GitLab's `feedback` capability.
import type { CommentDetail, FeedbackSnapshot, ReviewComment } from '../../forge';
import type { GraphQL } from './adapter';
import { query, typed, type Query, type Typed } from '../../graphql';
import { excerpt, MAX_EXCERPT_FILES } from '../../review-summary';

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

interface DetailNode {
  id: string;
  url: string | null;
  body: string;
  position?: {
    diffRefs?: { baseSha: string; headSha: string } | null;
    newPath: string | null;
    newLine: number | null;
    oldPath: string | null;
    oldLine: number | null;
  } | null;
  author: { username: string } | null;
  discussion?: {
    notes?: {
      nodes: Array<{ id: string; body: string; author: { username: string } | null }>;
    } | null;
  } | null;
}

type BlobData = Record<
  string,
  {
    repository?: {
      blobs?: { nodes: Array<{ path: string; rawTextBlob: string | null }> } | null;
    } | null;
  } | null
>;

const DETAIL_BATCH = 25;
// A thread's notes read for earlier replies. Longer threads show their first ones.
const THREAD_NOTES = 20;
const SHA = /^[0-9a-f]{40}$/;

// The file and commit that a diff note's line is in. A note on a removed line
// has only an old line, which is in the base commit.
function codeAt(position: DetailNode['position']) {
  const refs = position?.diffRefs;
  if (!refs) return undefined;
  if (position.newLine && position.newPath)
    return { sha: refs.headSha, path: position.newPath, line: position.newLine };
  if (position.oldLine && position.oldPath)
    return { sha: refs.baseSha, path: position.oldPath, line: position.oldLine };
  return undefined;
}

// Reads the notes with these numeric IDs, with their thread's earlier replies
// and the code around diff notes. A note's global ID changes with its type,
// but `Note` resolves every type.
export async function fetchDetails(
  transport: GraphQL,
  host: string,
  project: string,
  ids: string[],
): Promise<CommentDetail[]> {
  const graphql = typed(transport);
  const nodes: DetailNode[] = [];
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  for (let start = 0; start < numeric.length; start += DETAIL_BATCH) {
    const fields = numeric
      .slice(start, start + DETAIL_BATCH)
      .map(
        (id, index) =>
          `n${index}: note(id: "gid://gitlab/Note/${id}") { id url body author { username }
            position { diffRefs { baseSha headSha } newPath newLine oldPath oldLine }
            discussion { notes(first: ${THREAD_NOTES}) { nodes { id body author { username } } } } }`,
      )
      .join('\n');
    const data = await graphql(
      host,
      query<Record<string, DetailNode | null>>(`query { ${fields} }`),
      {},
    );
    for (const node of Object.values(data)) if (node?.author && node.url) nodes.push(node);
  }
  // Code is optional context, so the comments are summarized without it if
  // the files can't be read.
  const files = await readFiles(graphql, host, project, nodes).catch(
    () => new Map<string, string>(),
  );
  return nodes.map((node) => {
    const at = codeAt(node.position);
    const content = at && files.get(JSON.stringify([at.sha, at.path]));
    const text = content !== undefined && at ? excerpt(content, at.line) : undefined;
    const thread = node.discussion?.notes?.nodes ?? [];
    const position = thread.findIndex((note) => noteNumber(note.id) === noteNumber(node.id));
    const replies = (position > 0 ? thread.slice(0, position) : []).flatMap((note) =>
      note.author ? [{ username: note.author.username, body: note.body }] : [],
    );
    return {
      id: noteNumber(node.id),
      url: node.url ?? '',
      username: node.author?.username ?? '',
      body: node.body,
      ...(at ? { path: at.path, line: at.line } : {}),
      ...(text && at ? { code: { path: at.path, text } } : {}),
      ...(replies.length ? { replies } : {}),
    };
  });
}

// Reads each commented file once per commit, for at most a few files.
async function readFiles(
  graphql: Typed<Record<string, string>>,
  host: string,
  project: string,
  nodes: DetailNode[],
): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>();
  let count = 0;
  for (const node of nodes) {
    const at = codeAt(node.position);
    if (!at || !SHA.test(at.sha)) continue;
    const paths = wanted.get(at.sha) ?? new Set<string>();
    if (!paths.has(at.path) && count >= MAX_EXCERPT_FILES) continue;
    if (!paths.has(at.path)) count++;
    wanted.set(at.sha, paths.add(at.path));
  }
  const files = new Map<string, string>();
  if (!wanted.size) return files;
  const shas = [...wanted.keys()];
  const fields = shas
    .map(
      (sha, index) =>
        `b${index}: project(fullPath: ${JSON.stringify(project)}) { repository { blobs(paths: ${JSON.stringify([...wanted.get(sha)!])}, ref: ${JSON.stringify(sha)}) { nodes { path rawTextBlob } } } }`,
    )
    .join('\n');
  const data = await graphql(host, query<BlobData>(`query { ${fields} }`), {});
  shas.forEach((sha, index) => {
    for (const blob of data[`b${index}`]?.repository?.blobs?.nodes ?? [])
      if (blob.rawTextBlob !== null) files.set(JSON.stringify([sha, blob.path]), blob.rawTextBlob);
  });
  return files;
}
