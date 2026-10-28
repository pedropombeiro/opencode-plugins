// Links from GitLab review comments to other notes, which a summary may read
// with its linked-note tool. Only direct links in the comments themselves
// count, so nothing a linked note says can widen what a summary reads.
import type { CommentDetail, LinkedNote } from '../../forge';
import type { GraphQL } from './adapter';
import { query, typed } from '../../graphql';
import { MAX_LINK_LENGTH, MAX_LINKED_NOTES } from '../../review-summary';

export interface NoteLink {
  url: string;
  project: string;
  // Issues and work items share numbers, and GitLab names either as a work
  // item, so both count as the same resource.
  resource: 'issue' | 'merge_request';
  iid: string;
  noteID: string;
}

const PATH = /^\/(.+?)\/-\/(issues|work_items|merge_requests)\/(\d+)(\/diffs)?\/?$/;
const ANCHOR = /^#note_(\d+)$/;
const URLS = /https:\/\/[^\s<>()[\]"'`]+/g;
const NOTE_ID = /^gid:\/\/gitlab\/[A-Za-z]*Note\/(\d+)$/;

// The note a link names, when it's an HTTPS link without credentials or a
// port to an issue, work item, or MR note on `host`, a lowercase host name.
// Its URL is canonical: without a query, a trailing slash, or a diffs tab,
// and at most MAX_LINK_LENGTH long.
export function parseNoteLink(link: string, host: string): NoteLink | undefined {
  if (link.length > MAX_LINK_LENGTH * 2) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host || url.port)
    return undefined;
  if (url.username || url.password) return undefined;
  const note = url.hash.match(ANCHOR)?.[1];
  const path = url.pathname.match(PATH);
  if (!note || !path) return undefined;
  const [, project, kind, iid, diffs] = path;
  if (diffs && kind !== 'merge_requests') return undefined;
  if (project.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  const canonical = `https://${host}/${project}/-/${kind}/${iid}#note_${note}`;
  if (canonical.length > MAX_LINK_LENGTH) return undefined;
  return {
    url: canonical,
    project,
    resource: kind === 'merge_requests' ? 'merge_request' : 'issue',
    iid,
    noteID: note,
  };
}

const sameNote = (a: NoteLink, b: NoteLink) =>
  a.project.toLowerCase() === b.project.toLowerCase() &&
  a.resource === b.resource &&
  a.iid === b.iid &&
  a.noteID === b.noteID;

// The note links in the comments' own text, in order, without duplicates or
// links to the comments themselves, and at most MAX_LINKED_NOTES.
export function linkedNotes(host: string, details: readonly CommentDetail[]): string[] {
  const own = new Set(details.map((detail) => detail.id));
  const links: NoteLink[] = [];
  for (const detail of details) {
    for (const [match] of detail.body.matchAll(URLS)) {
      const link = parseNoteLink(match.replace(/[.,;:!?*_~]+$/, ''), host);
      if (!link || own.has(link.noteID)) continue;
      if (links.some((known) => sameNote(known, link))) continue;
      links.push(link);
      if (links.length === MAX_LINKED_NOTES) return links.map((entry) => entry.url);
    }
  }
  return links.map((entry) => entry.url);
}

interface LinkedNode {
  id: string;
  url: string | null;
  body: string;
  author: { username: string } | null;
}

// Reads the note a link names. GitLab returns nothing for notes the user
// can't read. The note's own URL must name the same project, issue or MR, and
// note as the link, so a note ID can't stand in for another resource.
export async function fetchLinkedNote(
  transport: GraphQL,
  host: string,
  url: string,
): Promise<LinkedNote | undefined> {
  const link = parseNoteLink(url, host);
  if (!link || link.url !== url) return undefined;
  const data = await typed(transport)(
    host,
    query<{ note?: LinkedNode | null }>(
      `query($id: NoteID!) { note(id: $id) { id url body author { username } } }`,
    ),
    { id: `gid://gitlab/Note/${link.noteID}` },
  );
  const node = data.note;
  if (!node?.author || !node.url) return undefined;
  // `Note` resolves every note type, and GitLab answers with the actual one,
  // such as `DiffNote` or `DiscussionNote`.
  if (node.id.match(NOTE_ID)?.[1] !== link.noteID) return undefined;
  const actual = parseNoteLink(node.url, host);
  if (!actual || !sameNote(actual, link)) return undefined;
  return { url: link.url, username: node.author.username, body: node.body };
}
