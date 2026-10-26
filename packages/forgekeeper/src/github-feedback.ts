import type { FeedbackSnapshot, ReviewComment } from './forge';
import type { GraphQL } from './github';
import { query, typed, type Query, type Typed } from './graphql';

type Variables = Record<string, string | number>;

interface Author {
  __typename: string;
  login: string;
  id: string;
}

interface CommentNode {
  id: string;
  url: string | null;
  isMinimized: boolean;
  lastEditedAt: string | null;
  author: Author | null;
}

interface IssueCommentNode extends CommentNode {
  createdAt: string;
  publishedAt: string | null;
}

interface ReviewNode extends CommentNode {
  state: string;
  body: string;
  submittedAt: string | null;
}

interface InlineCommentNode extends CommentNode {
  state: string;
  createdAt: string;
  publishedAt: string | null;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  comments: Connection<InlineCommentNode> | null;
}

interface Connection<Item> {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  nodes: Item[];
}

type Data<Field extends string, Item> = {
  viewer?: { id: string } | null;
  repository?: {
    pullRequest?: { [Name in Field]?: Connection<Item> | null } | null;
  } | null;
};

const PAGE_SIZE = 100;
export const MAX_COMMENT_PAGES = 20;
const MAX_FETCH_REQUESTS = 200;

const author =
  'author { __typename login ... on User { id } ... on Bot { id } ... on Mannequin { id } }';
const page = 'pageInfo { hasPreviousPage startCursor }';
const INLINE_FIELDS = `id url state createdAt publishedAt lastEditedAt isMinimized ${author}`;

const listQuery = <Field extends string, Item>(field: Field, connection: string) =>
  query<Data<Field, Item>>(`query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  viewer { id }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      ${field}(last: ${PAGE_SIZE}, before: $before) { ${page} nodes { ${connection} } }
    }
  }
}`);

const ISSUE_COMMENTS_QUERY = listQuery<'comments', IssueCommentNode>(
  'comments',
  `id url createdAt publishedAt lastEditedAt isMinimized ${author}`,
);

const REVIEWS_QUERY = listQuery<'reviews', ReviewNode>(
  'reviews',
  `id url state body submittedAt lastEditedAt isMinimized ${author}`,
);

const THREADS_QUERY = listQuery<'reviewThreads', ThreadNode>(
  'reviewThreads',
  `id isResolved comments(last: ${PAGE_SIZE}) { ${page} nodes { ${INLINE_FIELDS} } }`,
);

const THREAD_COMMENTS_QUERY = query<{
  node?: { comments?: Connection<InlineCommentNode> | null } | null;
}>(`query($id: ID!, $before: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(last: ${PAGE_SIZE}, before: $before) { ${page} nodes { ${INLINE_FIELDS} } }
    }
  }
}`);

const REVIEW_STATES = new Set(['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED']);

const time = (...values: Array<string | null | undefined>) => {
  const value = values.find((candidate) => candidate);
  return value ? Date.parse(value) : NaN;
};

const activity = (lastEditedAt: string | null, postedAt: number) => {
  const edited = lastEditedAt ? Date.parse(lastEditedAt) : NaN;
  return Number.isFinite(edited) ? Math.max(edited, postedAt) : postedAt;
};

interface Parts {
  node: CommentNode;
  postedAt: number;
  editedAt: number;
  resolved: boolean;
}

function build({ node, postedAt, editedAt, resolved }: Parts): ReviewComment | undefined {
  if (
    node.isMinimized ||
    !node.author?.id ||
    !Number.isFinite(postedAt) ||
    !Number.isFinite(editedAt)
  )
    return undefined;
  const { __typename, login } = node.author;
  return {
    id: node.id,
    order: postedAt,
    url: node.url ?? '',
    editedAt,
    resolved,
    bot: __typename === 'Bot' || login.endsWith('[bot]'),
    authorID: node.author.id,
    username: login,
  };
}

export function toIssueComment(node: IssueCommentNode): ReviewComment | undefined {
  const postedAt = time(node.publishedAt, node.createdAt);
  return build({
    node,
    postedAt,
    editedAt: activity(node.lastEditedAt, postedAt),
    resolved: false,
  });
}

export function toReview(node: ReviewNode): ReviewComment | undefined {
  if (!REVIEW_STATES.has(node.state) || !node.body.trim()) return undefined;
  const postedAt = time(node.submittedAt);
  return build({
    node,
    postedAt,
    editedAt: activity(node.lastEditedAt, postedAt),
    resolved: false,
  });
}

export function toInlineComment(
  node: InlineCommentNode,
  resolved: boolean,
): ReviewComment | undefined {
  if (node.state === 'PENDING') return undefined;
  const postedAt = time(node.publishedAt, node.createdAt);
  return build({
    node,
    postedAt,
    editedAt: activity(node.lastEditedAt, postedAt),
    resolved,
  });
}

interface Pages<Item> {
  items?: Item[];
  viewer?: string;
  complete: boolean;
}

interface PageLimit {
  pages: number;
  completeAtLimit: boolean;
}

const commentWindow: PageLimit = { pages: MAX_COMMENT_PAGES, completeAtLimit: true };
const allThreads: PageLimit = { pages: MAX_FETCH_REQUESTS, completeAtLimit: false };

async function readList<Field extends string, Item>(
  graphql: Typed<Variables>,
  host: string,
  base: Variables,
  text: Query<Data<Field, Item>>,
  field: Field,
  limit: PageLimit = commentWindow,
): Promise<Pages<Item>> {
  const pages: Item[][] = [];
  let viewer: string | undefined;
  let before: string | undefined;
  const result = (complete: boolean): Pages<Item> => ({
    items: pages.toReversed().flat(),
    viewer,
    complete,
  });
  for (let count = 0; count < limit.pages; count++) {
    const variables = before ? { ...base, before } : base;
    const data = await graphql(host, text, variables);
    viewer ??= data.viewer?.id ?? undefined;
    const connection = data.repository?.pullRequest?.[field];
    if (!connection) return count === 0 ? { viewer, complete: false } : result(false);
    pages.push(connection.nodes);
    if (!connection.pageInfo.hasPreviousPage) return result(true);
    before = connection.pageInfo.startCursor ?? undefined;
    if (!before) return result(false);
  }
  return result(limit.completeAtLimit);
}

async function readOlderComments(
  graphql: Typed<Variables>,
  host: string,
  thread: ThreadNode,
): Promise<{ comments: InlineCommentNode[]; complete: boolean }> {
  if (!thread.comments) return { comments: [], complete: false };
  const pages: InlineCommentNode[][] = [];
  let before = thread.comments?.pageInfo.hasPreviousPage
    ? (thread.comments.pageInfo.startCursor ?? undefined)
    : undefined;
  if (thread.comments?.pageInfo.hasPreviousPage && !before)
    return { comments: [], complete: false };
  for (let count = 1; before && count < MAX_COMMENT_PAGES; count++) {
    const data = await graphql(host, THREAD_COMMENTS_QUERY, { id: thread.id, before });
    const connection = data.node?.comments;
    if (!connection) return { comments: pages.toReversed().flat(), complete: false };
    pages.push(connection.nodes);
    before = connection.pageInfo.hasPreviousPage
      ? (connection.pageInfo.startCursor ?? undefined)
      : undefined;
    if (connection.pageInfo.hasPreviousPage && !before)
      return { comments: pages.toReversed().flat(), complete: false };
  }
  return { comments: pages.toReversed().flat(), complete: true };
}

export async function fetchComments(
  transport: GraphQL,
  host: string,
  project: string,
  number: string,
): Promise<FeedbackSnapshot | undefined> {
  let requests = 0;
  const graphql = typed<Variables>(async (...args) => {
    if (requests++ >= MAX_FETCH_REQUESTS) return {};
    return transport(...args);
  });
  const [owner, repo] = project.split('/');
  const base = { owner, repo, number: Number(number) };
  const [conversation, reviews, threads] = await Promise.all([
    readList(graphql, host, base, ISSUE_COMMENTS_QUERY, 'comments'),
    readList(graphql, host, base, REVIEWS_QUERY, 'reviews'),
    readList(graphql, host, base, THREADS_QUERY, 'reviewThreads', allThreads),
  ]);
  if (!conversation.items || !reviews.items || !threads.items) return undefined;
  const viewerID = conversation.viewer ?? reviews.viewer ?? threads.viewer;
  let threadsComplete = threads.complete;
  const inline: ReviewComment[] = [];
  for (const thread of threads.items) {
    const older = await readOlderComments(graphql, host, thread);
    threadsComplete &&= older.complete;
    for (const node of [...older.comments, ...(thread.comments?.nodes ?? [])]) {
      const comment = toInlineComment(node, thread.isResolved);
      if (comment) inline.push(comment);
    }
    inline.sort((a, b) => b.order - a.order);
    inline.splice(PAGE_SIZE * MAX_COMMENT_PAGES);
  }
  const comments = [
    ...conversation.items.map(toIssueComment),
    ...reviews.items.map(toReview),
    ...inline.sort((a, b) => a.order - b.order).slice(-PAGE_SIZE * MAX_COMMENT_PAGES),
  ].flatMap((comment) => comment ?? []);
  return {
    complete:
      conversation.complete && reviews.complete && threadsComplete && viewerID !== undefined,
    viewerID,
    comments: comments.sort((a, b) => a.order - b.order),
  };
}
